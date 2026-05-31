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
import { buscarCanal } from "./persistence";
import {
  carregarConversaParaEdicao,
  editarDadosColetados,
  enfileirarCampoForcado,
  editarCpfCliente,
} from "./conversas.dados";
import { sessionManager } from "./sessionManager";

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
