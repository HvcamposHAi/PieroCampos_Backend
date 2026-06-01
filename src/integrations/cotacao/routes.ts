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
import { exigirAdmin } from "../../middlewares/authSupabase";
import { logger } from "../../utils/logger";
import { confirmarEdispararCotacao } from "../../services/bot.service";
import { formatarComparativoParaWhatsApp } from "../segfy/segfy.format";
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

export const cotacaoRouter = router;
