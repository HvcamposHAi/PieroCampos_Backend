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
import { logger } from "../../utils/logger";
import { buscarCanal, e164ParaJid, registrarMensagemEntradaManual } from "./persistence";
import {
  carregarConversaParaEdicao,
  carregarConversaParaEnvio,
  definirEstadoConversa,
  editarDadosColetados,
  enfileirarCampoForcado,
  editarCpfCliente,
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

// Operador devolve ao robô: estado -> bot_ativo (mantém operador_id por auditoria).
// Reativa a Bia.
router.post("/conversas/:id/devolver", async (req: Request, res: Response) => {
  const conversaId = req.params.id ?? "";
  if (!conversaId) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  const autz = await autorizarConversa(req, res, conversaId);
  if (!autz) return;
  try {
    await definirEstadoConversa({ conversaId, estado: "bot_ativo" });
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
  if (conversa.estado !== "humano_assumiu") {
    res.status(409).json({ erro: "conversa_nao_assumida" });
    return;
  }
  const jid = conversa.telefone ? e164ParaJid(conversa.telefone) : null;
  if (!conversa.canal_id || !jid) {
    res.status(409).json({ erro: "destino_indisponivel" });
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
      canalId: conversa.canal_id,
      conversaId,
      jid,
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
  const jid = conversa.telefone ? e164ParaJid(conversa.telefone) : null;
  const canalId = conversa.canal_id;
  if (!canalId || !jid) {
    res.status(409).json({ erro: "destino_indisponivel" });
    return;
  }
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
  const jid = conversa.telefone ? e164ParaJid(conversa.telefone) : null;
  const canalId = conversa.canal_id;
  if (!canalId || !jid) {
    res.status(409).json({ erro: "destino_indisponivel" });
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
    const out = await sessionManager.enviarTextoBot({ canalId, conversaId, jid, texto });
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
      res.status(422).json({ erro: out.erro, ignorados: out.ignorados });
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
    const out = await enfileirarCampoForcado({
      conversaId,
      chave: parsed.data.chave,
      porEmail: autz.email,
      agoraIso: new Date().toISOString(),
    });
    if (!out.ok) {
      res.status(422).json({ erro: out.erro });
      return;
    }
    res.json({ ok: true, fila: out.fila });
  } catch (e) {
    logger.error("[wa.routes] perguntar campo falhou", { conversaId, erro: (e as Error).message });
    res.status(500).json({ erro: "perguntar_failed", mensagem: (e as Error).message });
  }
});

export const waRouter = router;
