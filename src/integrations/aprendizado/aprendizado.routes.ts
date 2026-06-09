/**
 * Rotas HTTP do Aprendizado contínuo (Admin > Aprendizado). Admin-only, exceto
 * o /cron (token compartilhado p/ pinger externo).
 *   - GET    /api/aprendizado            → versões (rascunho/ativa) + jobs recentes.
 *   - POST   /api/aprendizado/distillar  → dispara uma rodada (202, detached).
 *   - POST   /api/aprendizado/versoes/:id/ativar    → ativa uma versão.
 *   - POST   /api/aprendizado/versoes/:id/arquivar  → arquiva uma versão.
 *   - POST   /api/aprendizado/cron       → dispara via token (pinger). Público.
 *
 * A distillação roda detached (fire-and-forget) — não há fila de jobs no backend;
 * o status é consultado via GET. `exigirAdmin` é a defesa real (não a UI).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { exigirAdmin } from "../../middlewares/authSupabase";
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import {
  arquivarVersao,
  ativarVersao,
  definirAprendizadoAtivo,
  dispararDistillacao,
  obterAdmin,
} from "../../services/aprendizado.service";

const router = Router();

router.get("/", exigirAdmin, async (_req: Request, res: Response) => {
  try {
    const dados = await obterAdmin();
    res.json({ ok: true, ...dados });
  } catch (e) {
    logger.error("[aprendizado.routes] obter falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "get_failed", mensagem: (e as Error).message });
  }
});

// Toggle global liga/desliga (controle do usuário). Admin-only; auditado pelo
// middleware auditarMutacoes("aprendizado") montado no app.ts. NÃO gateia
// distillar/cron — só a injeção em runtime das versões ativas na Bia.
router.patch("/config", exigirAdmin, async (req: Request, res: Response) => {
  const parsed = z.object({ ativo: z.boolean() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "corpo_invalido" });
    return;
  }
  try {
    await definirAprendizadoAtivo(parsed.data.ativo, req.user?.email ?? null);
    const dados = await obterAdmin();
    res.json({ ok: true, ...dados });
  } catch (e) {
    logger.error("[aprendizado.routes] config falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "config_failed", mensagem: (e as Error).message });
  }
});

router.post("/distillar", exigirAdmin, async (req: Request, res: Response) => {
  const por = req.user?.email ?? "admin";
  // 202 imediato: o job pode demorar (chamadas ao Claude). Roda detached.
  res.status(202).json({ ok: true, status: "disparado" });
  void dispararDistillacao({ disparadoPor: por }).catch((e) => {
    logger.error("[aprendizado.routes] distillar (detached) falhou", { erro: (e as Error).message });
  });
});

router.post("/versoes/:id/ativar", exigirAdmin, async (req: Request, res: Response) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) {
    res.status(422).json({ erro: "id_invalido" });
    return;
  }
  try {
    await ativarVersao(id.data, req.user?.email ?? null);
    const dados = await obterAdmin();
    res.json({ ok: true, ...dados });
  } catch (e) {
    logger.error("[aprendizado.routes] ativar falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "ativar_failed", mensagem: (e as Error).message });
  }
});

router.post("/versoes/:id/arquivar", exigirAdmin, async (req: Request, res: Response) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) {
    res.status(422).json({ erro: "id_invalido" });
    return;
  }
  try {
    await arquivarVersao(id.data);
    const dados = await obterAdmin();
    res.json({ ok: true, ...dados });
  } catch (e) {
    logger.error("[aprendizado.routes] arquivar falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "arquivar_failed", mensagem: (e as Error).message });
  }
});

export const aprendizadoRouter = router;

/**
 * Router público p/ disparo agendado por pinger externo. Protegido por token
 * compartilhado (header x-cron-token == APRENDIZADO_CRON_TOKEN). Token vazio →
 * 404 (endpoint desabilitado). Não usa JWT.
 */
const publico = Router();
publico.post("/", async (req: Request, res: Response) => {
  const token = getEnv().APRENDIZADO_CRON_TOKEN;
  if (!token) {
    res.status(404).json({ erro: "cron_desabilitado" });
    return;
  }
  if (req.header("x-cron-token") !== token) {
    res.status(401).json({ erro: "token_invalido" });
    return;
  }
  res.status(202).json({ ok: true, status: "disparado" });
  void dispararDistillacao({ disparadoPor: "pinger" }).catch((e) => {
    logger.error("[aprendizado.routes] cron (detached) falhou", { erro: (e as Error).message });
  });
});

export const aprendizadoPublicoRouter = publico;
