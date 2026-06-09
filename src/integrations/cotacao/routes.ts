/**
 * Rotas HTTP de COTAÇÃO acionadas pelo OPERADOR (painel):
 *   - POST /api/cotacao/:conversaId/disparar — força a cotação no Segfy AGORA.
 *     Responde 202 e roda o pipeline em background (etapas/result chegam à tela
 *     via realtime); NÃO bloqueia a request (corrida Segfy ~30-120s, P7 do plano).
 *   - POST /api/cotacao/:conversaId/enviar — reenvia o comparativo da última
 *     cotação concluída ao cliente via WhatsApp.
 *
 * Admin-only (mesma convenção do /api/wa/send). O envio ao cliente é best-effort
 * (se o canal estiver offline, a cotação ainda fica visível na tela).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { exigirAdmin, exigirOperadorAtivo, corretoraEfetiva } from "../../middlewares/authSupabase";
import { logger } from "../../utils/logger";
import { confirmarEdispararCotacao } from "../../services/bot.service";
import { dispararCotacaoManual } from "../../services/cotacao-manual.service";
import { cpfValido } from "../../lib/cpf";
import { SegfyReauthNecessariaError, MSG_REAUTH_NECESSARIA } from "../segfy/errors";
import { formatarComparativoParaWhatsApp, formatarOpcaoUnicaParaWhatsApp } from "../segfy/segfy.format";
import type { ResultadoCotacaoItem } from "../segfy/segfy.types";
import { getSupabaseAdmin } from "../whatsapp/supabase";
import { sessionManager } from "../whatsapp/sessionManager";

const router = Router();

interface ConversaCotacao {
  id: string;
  canal_id: string | null;
  cliente_id: string;
  dados_coletados: Record<string, unknown>;
  /** JID autêntico capturado no inbound (preferido sobre o telefone — entrega p/ @lid). */
  wa_jid: string | null;
  clientes: { nome: string | null; telefone: string | null } | null;
}

async function carregar(conversaId: string): Promise<ConversaCotacao | null> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("conversas")
    .select("id, canal_id, cliente_id, dados_coletados, wa_jid, clientes(nome, telefone)")
    .eq("id", conversaId)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as ConversaCotacao;
}

/**
 * Callback de envio ao cliente. Resolve o destino preferindo o `wa_jid` autêntico
 * (entrega p/ contatos @lid; o telefone reconstruído NÃO entrega). Sem wa_jid,
 * resolve via onWhatsApp (sessionManager.resolverJid). Best-effort: o envio falho
 * não derruba a cotação (ela continua visível na tela), mas o motivo é logado.
 */
function enviarParaCliente(conv: ConversaCotacao, conversaId: string, operadorNome?: string) {
  let jidCache: string | null = null;
  return async (texto: string): Promise<void> => {
    if (!conv.canal_id) {
      logger.warn("[cotacao.routes] sem canal; comparativo não enviado", { conversaId });
      return;
    }
    try {
      if (!jidCache) {
        jidCache =
          conv.wa_jid ?? (await sessionManager.resolverJid(conv.canal_id, conv.clientes?.telefone ?? ""));
      }
      await sessionManager.enviarTexto({ canalId: conv.canal_id, conversaId, jid: jidCache, texto, operadorNome });
    } catch (e) {
      logger.warn("[cotacao.routes] envio ao cliente falhou (não-fatal)", {
        conversaId,
        erro: (e as Error).message,
      });
    }
  };
}

/**
 * COTAÇÃO MANUAL (operador): cria/obtém o cliente por CPF e dispara no Segfy SEM
 * passar pelo WhatsApp. Liberada a qualquer operador ativo (admin incluso).
 * Responde 202 com { clienteId, cotacaoId } assim que a cotação é criada; o
 * pipeline segue em background e a tela acompanha via realtime. NÃO envia nada
 * ao cliente. Rota de 1 segmento — não conflita com "/:conversaId/...".
 */
router.post("/manual", exigirOperadorAtivo, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    cliente?: { nome?: unknown; telefone?: unknown; cpf?: unknown; email?: unknown };
    dados?: Record<string, unknown>;
  };
  const nome = String(body.cliente?.nome ?? "").trim();
  const telefone = String(body.cliente?.telefone ?? "").trim();
  const cpf = String(body.cliente?.cpf ?? "").trim();
  const email = body.cliente?.email != null ? String(body.cliente.email).trim() : null;
  const dados = body.dados ?? {};

  if (!nome || !telefone || !cpf) {
    res.status(400).json({ erro: "dados_cliente_incompletos" });
    return;
  }
  if (!cpfValido(cpf)) {
    res.status(400).json({ erro: "cpf_invalido" });
    return;
  }

  // Corretora EFETIVA do operador (super-admin "dentro" de X cota em X).
  const corretoraId = req.operador ? corretoraEfetiva(req.operador) : null;
  if (!corretoraId) {
    res.status(409).json({ erro: "corretora_nao_selecionada", mensagem: "Selecione uma corretora no topo para cotar." });
    return;
  }
  try {
    const { clienteId, cotacaoId } = await dispararCotacaoManual({
      cliente: { nome, telefone, cpf, email },
      // Garante o CPF em `dados` (mapearParaCotacao prioriza o coletado).
      dados: { cpf, ...dados },
      corretoraId,
    });
    res.status(202).json({ ok: true, clienteId, cotacaoId });
  } catch (e) {
    // Sessão do Segfy caída → 409 p/ o front abrir o modal de reauth (sem criar card).
    if (e instanceof SegfyReauthNecessariaError) {
      res.status(409).json({ ok: false, erro: "reauth_necessaria", mensagem: MSG_REAUTH_NECESSARIA });
      return;
    }
    logger.error("[cotacao.routes] cotação manual falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "cotacao_manual_falhou", mensagem: (e as Error).message });
  }
});

router.post("/:conversaId/disparar", exigirAdmin, async (req: Request, res: Response) => {
  const conversaId = req.params.conversaId ?? "";
  if (!conversaId) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  const conv = await carregar(conversaId);
  if (!conv) {
    res.status(404).json({ erro: "conversa_nao_encontrada" });
    return;
  }
  // 202 imediato — pipeline roda em background; tela acompanha via realtime.
  res.status(202).json({ ok: true, mensagem: "cotacao_iniciada" });
  void confirmarEdispararCotacao({
    conversaId,
    clienteId: conv.cliente_id,
    dados: conv.dados_coletados ?? {},
    enviar: enviarParaCliente(conv, conversaId, req.user?.email),
  }).catch((e) => {
    logger.error("[cotacao.routes] disparo falhou", { conversaId, erro: (e as Error).message });
  });
});

router.post("/:conversaId/enviar", exigirAdmin, async (req: Request, res: Response) => {
  const conversaId = req.params.conversaId ?? "";
  if (!conversaId) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  const conv = await carregar(conversaId);
  if (!conv) {
    res.status(404).json({ erro: "conversa_nao_encontrada" });
    return;
  }
  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("cotacoes")
    .select("resultados")
    .eq("conversa_id", conversaId)
    .eq("status", "concluida")
    .order("criado_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  const resultados = (data?.resultados ?? null) as ResultadoCotacaoItem[] | null;
  if (!resultados || resultados.length === 0) {
    res.status(404).json({ erro: "sem_cotacao_concluida" });
    return;
  }
  const texto = formatarComparativoParaWhatsApp(resultados, conv.clientes?.nome ?? "tudo certo");
  await enviarParaCliente(conv, conversaId, req.user?.email)(texto);
  res.json({ ok: true });
});

const escolherSchema = z.object({ seguradora: z.string().trim().min(1, "seguradora obrigatória") });

/**
 * ESCOLHA MANUAL do operador: dentre os resultados cotados da cotação, escolhe UMA
 * seguradora; só ela é enviada ao cliente no WhatsApp (formatarOpcaoUnicaParaWhatsApp).
 * Grava a escolha + `enviado_ao_cliente_em` (move o card de "Cotações pendentes"
 * p/ "Cotações enviadas") e leva a conversa a `cotacao_enviada`. Idempotente: a
 * 2ª chamada (já enviada) responde 409 e não reenvia. Keyed por COTAÇÃO (não conversa).
 */
router.post("/:cotacaoId/escolher", exigirAdmin, async (req: Request, res: Response) => {
  const cotacaoId = req.params.cotacaoId ?? "";
  if (!cotacaoId) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  const parsed = escolherSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }

  const sb = getSupabaseAdmin();
  const { data: cot } = await sb
    .from("cotacoes")
    .select("id, conversa_id, status, resultados, enviado_ao_cliente_em")
    .eq("id", cotacaoId)
    .maybeSingle();
  if (!cot) {
    res.status(404).json({ erro: "cotacao_nao_encontrada" });
    return;
  }
  const c = cot as {
    id: string;
    conversa_id: string | null;
    status: string;
    resultados: ResultadoCotacaoItem[] | null;
    enviado_ao_cliente_em: string | null;
  };

  // Idempotência: já enviada → não reenvia.
  if (c.enviado_ao_cliente_em) {
    res.status(409).json({ erro: "ja_enviada" });
    return;
  }

  // A seguradora escolhida deve existir entre os resultados COTADOS (integridade).
  const resultados = Array.isArray(c.resultados) ? c.resultados : [];
  const alvo = parsed.data.seguradora.trim().toLowerCase();
  const escolhido = resultados.find(
    (r) => (r?.seguradora ?? "").trim().toLowerCase() === alvo && r?.status === "cotado",
  );
  if (!escolhido) {
    res.status(422).json({ erro: "seguradora_invalida", mensagem: "Seguradora não está entre os resultados cotados." });
    return;
  }

  // Envia SÓ a opção escolhida ao cliente (best-effort; cotação manual sem
  // conversa não tem cliente no WhatsApp → só registra a escolha).
  if (c.conversa_id) {
    const conv = await carregar(c.conversa_id);
    if (conv) {
      const texto = formatarOpcaoUnicaParaWhatsApp(escolhido, conv.clientes?.nome ?? "tudo certo");
      await enviarParaCliente(conv, c.conversa_id, req.user?.email)(texto);
    }
  }

  // Grava a escolha + marca enviada. O `.is(enviado_ao_cliente_em, null)` torna a
  // gravação idempotente também sob corrida (duplo clique / 2 abas).
  const { error: upErr } = await sb
    .from("cotacoes")
    .update({
      escolha_seguradora: escolhido.seguradora,
      escolha_plano: escolhido,
      enviado_ao_cliente_em: new Date().toISOString(),
      escolhido_por: req.user?.id ?? null,
    })
    .eq("id", cotacaoId)
    .is("enviado_ao_cliente_em", null);
  if (upErr) {
    res.status(500).json({ erro: "falha_ao_gravar", mensagem: upErr.message });
    return;
  }

  // Conversa → cotacao_enviada (coerente com o fluxo de aceite futuro).
  if (c.conversa_id) {
    await sb.from("conversas").update({ estado: "cotacao_enviada" }).eq("id", c.conversa_id);
  }

  logger.info("[cotacao.routes] opção escolhida e enviada ao cliente", {
    cotacaoId,
    seguradora: escolhido.seguradora,
  });
  res.json({ ok: true });
});

export const cotacaoRouter = router;
