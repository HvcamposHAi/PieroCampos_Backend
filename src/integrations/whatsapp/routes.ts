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
import { exigirAdmin } from "../../middlewares/authSupabase";
import { logger } from "../../utils/logger";
import { buscarCanal } from "./persistence";
import { sessionManager } from "./sessionManager";

const router = Router();

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

export const waRouter = router;
