/**
 * Router Express para o módulo WhatsApp.
 *
 * Convenção:
 *   - Tudo em /api/wa/* exige JWT válido (middleware do app.ts).
 *   - Ações que alteram canal (connect, disconnect, send) exigem perfil admin.
 *     send é admin também aqui — operadores futuramente passam por um endpoint
 *     scoped por conversa atribuída (fora do escopo desta fase).
 *
 * Erros: 401 (auth), 403 (admin), 404 (canal inexistente), 409 (conflito de
 * estado), 422 (input inválido), 500 (interno).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { exigirAdmin, isAdmin, carregarOperadorAtivo } from "../../middlewares/authSupabase";
import { getRoteiro } from "../../lib/roteiros";
import { lerSistemaDoCanal } from "../../services/agente-config.service";
import { logger } from "../../utils/logger";
import {
  buscarCanal,
  atualizarCanal,
  lerBotAtivoCanal,
  registrarMensagemEntradaManual,
} from "./persistence";
import {
  carregarConversaParaEdicao,
  carregarConversaParaEnvio,
  type ConversaParaEnvio,
  definirEstadoConversa,
  gravarWaJid,
  editarDadosColetados,
  enfileirarCampoForcado,
  editarCpfCliente,
  editarTelefoneCliente,
} from "./conversas.dados";
import { sessionManager } from "./sessionManager";
import { processarMensagem, gerarMensagemBia } from "../../services/bot.service";

const router = Router();

/**
 * Autoriza o req.user a operar a conversa: admin sempre; senão, operador ATIVO
 * desde que a conversa esteja sem dono (na fila) ou atribuída a ele próprio.
 * Responde o status apropriado e retorna null quando não autorizado.
 */
async function autorizarConversa(
  req: Request,
  res: Response,
  conversaId: string,
): Promise<{ email: string | undefined } | null> {
  const conversa = await carregarConversaParaEdicao(conversaId);
  if (!conversa) {
    res.status(404).json({ erro: "conversa_nao_encontrada" });
    return null;
  }
  if (await isAdmin(req)) return { email: req.user?.email };

  const operador = await carregarOperadorAtivo(req);
  if (!operador) {
    res.status(403).json({ erro: "operador_required" });
    return null;
  }
  if (conversa.operador_id && conversa.operador_id !== operador.id) {
    res.status(403).json({ erro: "conversa_de_outro_operador" });
    return null;
  }
  return { email: req.user?.email };
}

/**
 * Resolve o JID ENTREGÁVEL de uma conversa para envio out-of-band (operador/IA/
 * simular). Prioriza o `wa_jid` autêntico (capturado no inbound); se ausente,
 * resolve via onWhatsApp e cacheia. Lança: "destino_indisponivel" (sem canal/
 * telefone) ou "numero_nao_whatsapp" (conta não existe). Retorna { canalId, jid }.
 */
async function resolverDestino(
  conversa: ConversaParaEnvio,
): Promise<{ canalId: string; jid: string }> {
  if (!conversa.canal_id) throw new Error("destino_indisponivel");
  if (conversa.wa_jid) return { canalId: conversa.canal_id, jid: conversa.wa_jid };
  if (!conversa.telefone) throw new Error("destino_indisponivel");
  const jid = await sessionManager.resolverJid(conversa.canal_id, conversa.telefone);
  await gravarWaJid(conversa.id, jid).catch(() => {}); // cache best-effort
  return { canalId: conversa.canal_id, jid };
}

/** Traduz o erro de resolverDestino em status/erro HTTP e responde. */
function responderErroDestino(res: Response, e: unknown): void {
  const msg = e instanceof Error ? e.message : "destino";
  if (msg === "numero_nao_whatsapp") {
    res.status(409).json({ erro: "numero_nao_whatsapp" });
    return;
  }
  res.status(409).json({ erro: "destino_indisponivel", mensagem: msg });
}

router.post("/canais/:id/connect", exigirAdmin, async (req: Request, res: Response) => {
  const canalId = req.params.id ?? "";
  if (!canalId) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  try {
    const canal = await buscarCanal(canalId);
    if (!canal) {
      res.status(404).json({ erro: "canal_nao_encontrado" });
      return;
    }
    const out = await sessionManager.connect(canalId);
    res.json({ ok: true, ...out });
  } catch (e) {
    logger.error("[wa.routes] connect falhou", { canalId, erro: (e as Error).message });
    res.status(500).json({ erro: "connect_failed", mensagem: (e as Error).message });
  }
});

router.post("/canais/:id/disconnect", exigirAdmin, async (req: Request, res: Response) => {
  const canalId = req.params.id ?? "";
  if (!canalId) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  const logout = req.query.logout === "true";
  try {
    await sessionManager.disconnect(canalId, { logout });
    res.json({ ok: true, logout });
  } catch (e) {
    logger.error("[wa.routes] disconnect falhou", { canalId, erro: (e as Error).message });
    res.status(500).json({ erro: "disconnect_failed", mensagem: (e as Error).message });
  }
});

/**
 * Liga/desliga a Bia NESTA linha (master switch por canal). NÃO toca na conexão
 * WhatsApp: só grava `canais.bot_ativo`. A sessão Baileys segue conectada e os
 * operadores continuam enviando pela linha — só a Bia fica muda. Livre demanda.
 *
 * Autz: admin alterna QUALQUER linha (toggle do Admin desktop). Operador ativo
 * só alterna a SUA linha (operadores.canal_padrao_id) — base da página móvel /bot.
 */
const botAtivoSchema = z.object({ bot_ativo: z.boolean() });

router.patch("/canais/:id/bot-ativo", async (req: Request, res: Response) => {
  const canalId = req.params.id ?? "";
  if (!canalId) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  const parsed = botAtivoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido" });
    return;
  }
  // admin: qualquer linha. operador ativo: só a linha dele (canal_padrao_id).
  if (!(await isAdmin(req))) {
    const op = await carregarOperadorAtivo(req);
    if (!op) {
      res.status(403).json({ erro: "operador_required" });
      return;
    }
    if (op.canal_padrao_id !== canalId) {
      res.status(403).json({ erro: "operador_nao_dono_da_linha" });
      return;
    }
  }
  try {
    const canal = await buscarCanal(canalId);
    if (!canal) {
      res.status(404).json({ erro: "canal_nao_encontrado" });
      return;
    }
    await atualizarCanal(canalId, { bot_ativo: parsed.data.bot_ativo });
    res.json({ ok: true, bot_ativo: parsed.data.bot_ativo });
  } catch (e) {
    logger.error("[wa.routes] bot-ativo falhou", { canalId, erro: (e as Error).message });
    res.status(500).json({ erro: "bot_ativo_failed", mensagem: (e as Error).message });
  }
});

/**
 * Configura o ALERTA de handoff desta linha (Admin > Linhas WhatsApp).
 *   - `ativo`: liga/desliga o aviso no WhatsApp do operador.
 *   - `numero`: destino (só dígitos, E.164 sem '+'); ""/null = o próprio número
 *     da linha (a Bia avisa a si mesma).
 *
 * Autz: SOMENTE admin (config de roteamento sensível — não relaxar p/ operador
 * como o bot-ativo). Cai sob `auditarMutacoes("whatsapp")` montado no app.ts.
 */
const alertaSchema = z.object({
  ativo: z.boolean(),
  numero: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (v ?? "").replace(/\D/g, ""))
    .refine((v) => v === "" || /^[0-9]{10,15}$/.test(v), {
      message: "numero_invalido",
    }),
});

router.patch("/canais/:id/alerta", exigirAdmin, async (req: Request, res: Response) => {
  const canalId = req.params.id ?? "";
  if (!canalId) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  const parsed = alertaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido" });
    return;
  }
  const numero = parsed.data.numero === "" ? null : parsed.data.numero;
  try {
    const canal = await buscarCanal(canalId);
    if (!canal) {
      res.status(404).json({ erro: "canal_nao_encontrado" });
      return;
    }
    await atualizarCanal(canalId, {
      alerta_handoff_ativo: parsed.data.ativo,
      alerta_numero_e164: numero,
    });
    res.json({ ok: true, alerta_handoff_ativo: parsed.data.ativo, alerta_numero_e164: numero });
  } catch (e) {
    logger.error("[wa.routes] alerta falhou", { canalId, erro: (e as Error).message });
    res.status(500).json({ erro: "alerta_failed", mensagem: (e as Error).message });
  }
});

router.get("/canais/:id/status", async (req: Request, res: Response) => {
  const canalId = req.params.id ?? "";
  if (!canalId) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  try {
    const canal = await buscarCanal(canalId);
    if (!canal) {
      res.status(404).json({ erro: "canal_nao_encontrado" });
      return;
    }
    const session = sessionManager.get(canalId);
    res.json({
      ok: true,
      id: canal.id,
      status: canal.status,
      provider: canal.provider,
      numero_e164: canal.numero_e164,
      display_name: canal.display_name,
      qr_expires_at: canal.qr_expires_at,
      em_memoria: !!session,
      last_disconnect_reason: canal.last_disconnect_reason,
    });
  } catch (e) {
    res.status(500).json({ erro: "status_failed", mensagem: (e as Error).message });
  }
});

const sendSchema = z.object({
  canalId: z.string().uuid(),
  conversaId: z.string().uuid(),
  jid: z.string().min(8),
  texto: z.string().min(1).max(4096),
});

router.post("/send", exigirAdmin, async (req: Request, res: Response) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    const out = await sessionManager.enviarTexto({
      canalId: parsed.data.canalId,
      conversaId: parsed.data.conversaId,
      jid: parsed.data.jid,
      texto: parsed.data.texto,
      operadorNome: req.user?.email,
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    logger.error("[wa.routes] send falhou", {
      canalId: parsed.data.canalId,
      erro: (e as Error).message,
    });
    res.status(409).json({ erro: "send_failed", mensagem: (e as Error).message });
  }
});

// ----------------------------------------------------------------------------
// Atendimento humano — assumir / responder / devolver (operador dono ou admin).
// Diferente de /send (admin), estas rotas são escopadas por conversa atribuída.
// ----------------------------------------------------------------------------

// Operador assume a conversa: estado -> humano_assumiu e vira dono. Silencia a
// Bia (decidirModoBia). Idempotente. Dispara a trigger de notificação de handoff.
router.post("/conversas/:id/assumir", async (req: Request, res: Response) => {
  const conversaId = req.params.id ?? "";
  if (!conversaId) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  const autz = await autorizarConversa(req, res, conversaId);
  if (!autz) return; // resposta já enviada
  const operador = await carregarOperadorAtivo(req);
  if (!operador) {
    res.status(403).json({ erro: "operador_required" });
    return;
  }
  try {
    await definirEstadoConversa({
      conversaId,
      estado: "humano_assumiu",
      operadorId: operador.id,
    });
    res.json({ ok: true, estado: "humano_assumiu" });
  } catch (e) {
    logger.error("[wa.routes] assumir falhou", { conversaId, erro: (e as Error).message });
    res.status(500).json({ erro: "assumir_failed", mensagem: (e as Error).message });
  }
});

// Operador devolve ao robô: estado -> bot_ativo e LIMPA o dono (operador_id=null)
// para coerência na Fila (sem dono = do bot). Reativa a Bia (responde no próximo
// inbound). O histórico do atendimento fica em mensagens/notificacoes.
router.post("/conversas/:id/devolver", async (req: Request, res: Response) => {
  const conversaId = req.params.id ?? "";
  if (!conversaId) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  const autz = await autorizarConversa(req, res, conversaId);
  if (!autz) return;
  try {
    await definirEstadoConversa({ conversaId, estado: "bot_ativo", operadorId: null });
    res.json({ ok: true, estado: "bot_ativo" });
  } catch (e) {
    logger.error("[wa.routes] devolver falhou", { conversaId, erro: (e as Error).message });
    res.status(500).json({ erro: "devolver_failed", mensagem: (e as Error).message });
  }
});

// Operador envia uma mensagem ao cliente. O backend deriva canal + JID da própria
// conversa (não confia em valores do browser). Só permite em humano_assumiu.
const responderSchema = z.object({ texto: z.string().min(1).max(4096) });

router.post("/conversas/:id/responder", async (req: Request, res: Response) => {
  const conversaId = req.params.id ?? "";
  if (!conversaId) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  const parsed = responderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  const autz = await autorizarConversa(req, res, conversaId);
  if (!autz) return;

  const conversa = await carregarConversaParaEnvio(conversaId);
  if (!conversa) {
    res.status(404).json({ erro: "conversa_nao_encontrada" });
    return;
  }
  // Normalmente só responde em humano_assumiu. EXCEÇÃO: linha com a Bia desligada
  // (canais.bot_ativo=false) — aí o operador conduz tudo e a conversa pode seguir
  // em bot_ativo; liberamos o envio e o claim-on-send abaixo a transiciona para
  // humano_assumiu (a Bia já está muda pelo gate de linha, sem conflito).
  const linhaBotOff = !(await lerBotAtivoCanal(conversa.canal_id ?? ""));
  if (conversa.estado !== "humano_assumiu" && !linhaBotOff) {
    res.status(409).json({ erro: "conversa_nao_assumida" });
    return;
  }
  let destino: { canalId: string; jid: string };
  try {
    destino = await resolverDestino(conversa);
  } catch (e) {
    responderErroDestino(res, e);
    return;
  }
  // Claim-on-send: se a conversa chegou em humano_assumiu por handoff automático
  // (sem dono), o ato de responder vira posse — assim a Bia para de acolher
  // (decidirModoBia passa a 'mudo'). Best-effort: não bloqueia o envio.
  if (!conversa.operador_id) {
    const operador = await carregarOperadorAtivo(req);
    if (operador) {
      try {
        await definirEstadoConversa({
          conversaId,
          estado: "humano_assumiu",
          operadorId: operador.id,
        });
      } catch (e) {
        logger.warn("[wa.routes] claim-on-send falhou", {
          conversaId,
          erro: (e as Error).message,
        });
      }
    }
  }
  try {
    const out = await sessionManager.enviarTexto({
      canalId: destino.canalId,
      conversaId,
      jid: destino.jid,
      texto: parsed.data.texto,
      operadorNome: autz.email,
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    logger.error("[wa.routes] responder falhou", { conversaId, erro: (e as Error).message });
    res.status(409).json({ erro: "send_failed", mensagem: (e as Error).message });
  }
});

// Simulador: injeta uma fala do cliente no fluxo REAL do bot (mesmo brain do
// inbound Baileys). O bot responde via sessionManager.enviarTextoBot — entrega
// no WhatsApp se o canal estiver conectado e o número for real. Substitui o
// simulador antigo do frontend (responderBot), que só persistia.
const simularSchema = z.object({ texto: z.string().min(1).max(4000) });

router.post("/conversas/:id/simular-cliente", async (req: Request, res: Response) => {
  const conversaId = req.params.id ?? "";
  if (!conversaId) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  const parsed = simularSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  const autz = await autorizarConversa(req, res, conversaId);
  if (!autz) return;

  const conversa = await carregarConversaParaEnvio(conversaId);
  if (!conversa) {
    res.status(404).json({ erro: "conversa_nao_encontrada" });
    return;
  }
  let destino: { canalId: string; jid: string };
  try {
    destino = await resolverDestino(conversa);
  } catch (e) {
    responderErroDestino(res, e);
    return;
  }
  const { canalId, jid } = destino;
  try {
    await registrarMensagemEntradaManual(conversaId, parsed.data.texto);
    await processarMensagem({
      canalId,
      conversaId,
      jidRemoto: jid,
      textoCliente: parsed.data.texto,
      enviar: async (t) => {
        await sessionManager.enviarTextoBot({ canalId, conversaId, jid, texto: t });
      },
      enviarDocumento: async (doc) => {
        await sessionManager.enviarDocumentoBot({
          canalId,
          conversaId,
          jid,
          documento: doc.documento,
          fileName: doc.fileName,
          mimetype: doc.mimetype,
          caption: doc.caption,
        });
      },
    });
    res.json({ ok: true });
  } catch (e) {
    logger.error("[wa.routes] simular-cliente falhou", { conversaId, erro: (e as Error).message });
    res.status(500).json({ erro: "simular_failed", mensagem: (e as Error).message });
  }
});

// IA gera e envia: a Bia compõe UMA mensagem proativa (instrução opcional do
// operador) e o backend entrega via Baileys (origem='bot'). Exige canal conectado.
const biaGerarSchema = z.object({ instrucao: z.string().max(1000).optional() });

router.post("/conversas/:id/bia-gerar", async (req: Request, res: Response) => {
  const conversaId = req.params.id ?? "";
  if (!conversaId) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  const parsed = biaGerarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  const autz = await autorizarConversa(req, res, conversaId);
  if (!autz) return;

  const conversa = await carregarConversaParaEnvio(conversaId);
  if (!conversa) {
    res.status(404).json({ erro: "conversa_nao_encontrada" });
    return;
  }
  let destino: { canalId: string; jid: string };
  try {
    destino = await resolverDestino(conversa);
  } catch (e) {
    responderErroDestino(res, e);
    return;
  }
  let texto: string | null;
  try {
    texto = await gerarMensagemBia(conversaId, parsed.data.instrucao);
  } catch (e) {
    logger.error("[wa.routes] bia-gerar (claude) falhou", {
      conversaId,
      erro: (e as Error).message,
    });
    res.status(502).json({ erro: "bia_falhou", mensagem: (e as Error).message });
    return;
  }
  if (!texto) {
    res.status(422).json({ erro: "bia_sem_texto" });
    return;
  }
  try {
    const out = await sessionManager.enviarTextoBot({
      canalId: destino.canalId,
      conversaId,
      jid: destino.jid,
      texto,
    });
    res.json({ ok: true, texto, ...out });
  } catch (e) {
    logger.error("[wa.routes] bia-gerar (envio) falhou", {
      conversaId,
      erro: (e as Error).message,
    });
    res.status(409).json({ erro: "send_failed", mensagem: (e as Error).message });
  }
});

// ----------------------------------------------------------------------------
// Dados coletados da conversa — edição manual e "pedir ao bot" (operador/admin).
// ----------------------------------------------------------------------------

/** Mensagem legível (PT-BR) p/ os códigos de erro de validação de campos do roteiro. */
function mensagemErroCampo(erro: string): string {
  switch (erro) {
    case "chave_invalida":
      return "Este campo não faz parte do roteiro deste sistema de cotação.";
    case "categoria_sem_roteiro":
      return "Esta conversa ainda não tem uma categoria com roteiro definido.";
    case "nenhuma_chave_valida":
      return "Nenhum dos campos enviados é válido para o roteiro desta conversa.";
    default:
      return "Não foi possível concluir a operação.";
  }
}

const editarDadosSchema = z.object({
  campos: z.record(z.string(), z.string()).refine((o) => Object.keys(o).length > 0, {
    message: "campos vazio",
  }),
});

router.patch("/conversas/:id/dados-coletados", async (req: Request, res: Response) => {
  const conversaId = req.params.id ?? "";
  if (!conversaId) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  const parsed = editarDadosSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  const autz = await autorizarConversa(req, res, conversaId);
  if (!autz) return; // resposta já enviada
  try {
    const out = await editarDadosColetados({
      conversaId,
      campos: parsed.data.campos,
      porEmail: autz.email,
      agoraIso: new Date().toISOString(),
    });
    if (!out.ok) {
      res.status(422).json({ erro: out.erro, mensagem: mensagemErroCampo(out.erro), ignorados: out.ignorados });
      return;
    }
    res.json({ ok: true, atualizados: out.atualizados, ignorados: out.ignorados });
  } catch (e) {
    logger.error("[wa.routes] editar dados falhou", { conversaId, erro: (e as Error).message });
    res.status(500).json({ erro: "editar_failed", mensagem: (e as Error).message });
  }
});

// CPF do CADASTRO do cliente (clientes.cpf) — editável pelo operador no Resumo.
const editarCpfSchema = z.object({ cpf: z.string().min(1).max(20) });

router.patch("/conversas/:id/cliente-cpf", async (req: Request, res: Response) => {
  const conversaId = req.params.id ?? "";
  if (!conversaId) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  const parsed = editarCpfSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  const autz = await autorizarConversa(req, res, conversaId);
  if (!autz) return;
  try {
    const out = await editarCpfCliente({ conversaId, cpf: parsed.data.cpf, porEmail: autz.email });
    if (!out.ok) {
      const msg = out.erro === "cpf_invalido" ? "CPF inválido — verifique os 11 dígitos." : "Cliente não encontrado.";
      res.status(422).json({ erro: out.erro, mensagem: msg });
      return;
    }
    res.json({ ok: true, cpf: out.cpf });
  } catch (e) {
    logger.error("[wa.routes] editar cpf falhou", { conversaId, erro: (e as Error).message });
    res.status(500).json({ erro: "editar_cpf_failed", mensagem: (e as Error).message });
  }
});

// TELEFONE do cadastro (clientes.telefone) — editável pelo operador (corrige
// número errado vindo de contato @lid). Não altera o wa_jid (endereço de envio).
const editarTelefoneSchema = z.object({ telefone: z.string().min(1).max(30) });

router.patch("/conversas/:id/cliente-telefone", async (req: Request, res: Response) => {
  const conversaId = req.params.id ?? "";
  if (!conversaId) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  const parsed = editarTelefoneSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  const autz = await autorizarConversa(req, res, conversaId);
  if (!autz) return;
  try {
    const out = await editarTelefoneCliente({
      conversaId,
      telefone: parsed.data.telefone,
      porEmail: autz.email,
    });
    if (!out.ok) {
      const msg =
        out.erro === "telefone_invalido"
          ? "Telefone inválido — use DDD + número (ex.: 41 99999-9999)."
          : "Cliente não encontrado.";
      res.status(422).json({ erro: out.erro, mensagem: msg });
      return;
    }
    res.json({ ok: true, telefone: out.telefone });
  } catch (e) {
    logger.error("[wa.routes] editar telefone falhou", { conversaId, erro: (e as Error).message });
    res.status(500).json({ erro: "editar_telefone_failed", mensagem: (e as Error).message });
  }
});

const perguntarCampoSchema = z.object({
  chave: z.string().min(1).max(64),
});

router.post("/conversas/:id/perguntar-campo", async (req: Request, res: Response) => {
  const conversaId = req.params.id ?? "";
  if (!conversaId) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  const parsed = perguntarCampoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  const autz = await autorizarConversa(req, res, conversaId);
  if (!autz) return;
  try {
    // 1) Enfileira (fonte de verdade p/ o follow-up no próximo inbound). Mantido.
    const out = await enfileirarCampoForcado({
      conversaId,
      chave: parsed.data.chave,
      porEmail: autz.email,
      agoraIso: new Date().toISOString(),
    });
    if (!out.ok) {
      res.status(422).json({ erro: out.erro, mensagem: mensagemErroCampo(out.erro) });
      return;
    }

    // 2) Dispara a pergunta da Bia ao cliente AGORA (best-effort): a Bia compõe
    //    e o backend entrega via Baileys (origem='bot'). Se algo falhar, o campo
    //    continua na fila e o bot pergunta no próximo inbound — não derruba.
    let enviado = false;
    let motivo: string | undefined;
    try {
      const conversa = await carregarConversaParaEnvio(conversaId);
      if (!conversa) throw new Error("conversa_nao_encontrada");
      const destino = await resolverDestino(conversa);
      // Roteiro por-sistema: rótulo/dica do campo dependem do sistema da corretora
      // (ex.: data_nascimento/sexo só existem no Aggilizador).
      const sistema = await lerSistemaDoCanal(conversa.canal_id);
      const campo = getRoteiro(
        conversa.categoria as Parameters<typeof getRoteiro>[0],
        undefined,
        sistema,
      )?.campos.find((c) => c.chave === parsed.data.chave);
      const alvo = campo?.rotulo ?? parsed.data.chave;
      const instrucao =
        `Pergunte ao cliente, de forma natural e curta, o seguinte dado que ainda falta: ` +
        `"${alvo}"${campo?.dica ? ` — ${campo.dica}` : ""}. Faça só essa pergunta.`;
      const texto = await gerarMensagemBia(conversaId, instrucao);
      if (!texto) throw new Error("bia_sem_texto");
      await sessionManager.enviarTextoBot({
        canalId: destino.canalId,
        conversaId,
        jid: destino.jid,
        texto,
      });
      enviado = true;
    } catch (e) {
      motivo = e instanceof Error ? e.message : "envio_falhou";
      logger.warn("[wa.routes] perguntar-campo: disparo proativo falhou (fica na fila)", {
        conversaId,
        chave: parsed.data.chave,
        erro: motivo,
      });
    }

    res.json({ ok: true, fila: out.fila, enviado, ...(motivo ? { motivo } : {}) });
  } catch (e) {
    logger.error("[wa.routes] perguntar campo falhou", { conversaId, erro: (e as Error).message });
    res.status(500).json({ erro: "perguntar_failed", mensagem: (e as Error).message });
  }
});

export const waRouter = router;
