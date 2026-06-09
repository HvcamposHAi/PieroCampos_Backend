/**
 * Rotas HTTP do Mapeamento Dinâmico (Admin › Mapeamento). Admin-only.
 *   - GET    /api/mapeamento?provider=&ramo=     → schema (padrão/override) + regras + toggle.
 *   - PUT    /api/mapeamento/schema              → salva override de schema da corretora.
 *   - PATCH  /api/mapeamento/config {ativo}       → liga/desliga o toggle da corretora.
 *   - POST   /api/mapeamento/regras/:id/aprovar  → pendente→ativo (arquiva conflitante).
 *   - POST   /api/mapeamento/regras/:id/arquivar → arquiva regra.
 *
 * `exigirAdmin` + `exigirCorretoraSelecionada` são a defesa real (não a UI).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { exigirAdmin, exigirCorretoraSelecionada } from "../../../middlewares/authSupabase";
import { logger } from "../../../utils/logger";
import { camposSchema, salvarSchema } from "./schema-store";
import { definirMapperDinamicoAtivo } from "./dynamic-mapper.service";
import { aprovarRegra, arquivarRegra, obterMapeamentoAdmin, invalidarCachesMapeamento } from "./mapper-admin.service";

const router = Router();

const ALVO_PADRAO = { provider: "segfy", ramo: "auto" };
function lerAlvo(req: Request): { provider: string; ramo: string } {
  const provider = typeof req.query.provider === "string" && req.query.provider ? req.query.provider : ALVO_PADRAO.provider;
  const ramo = typeof req.query.ramo === "string" && req.query.ramo ? req.query.ramo : ALVO_PADRAO.ramo;
  return { provider, ramo };
}

router.get("/", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const { provider, ramo } = lerAlvo(req);
  try {
    const dados = await obterMapeamentoAdmin(provider, ramo, req.corretoraId!);
    res.json({ ok: true, ...dados });
  } catch (e) {
    logger.error("[mapper.routes] obter falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "get_failed", mensagem: (e as Error).message });
  }
});

const putSchemaSchema = z.object({
  provider: z.string().min(1).default(ALVO_PADRAO.provider),
  ramo: z.string().min(1).default(ALVO_PADRAO.ramo),
  campos: camposSchema,
});

router.put("/schema", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const parsed = putSchemaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    await salvarSchema({
      corretoraId: req.corretoraId!,
      provider: parsed.data.provider,
      ramo: parsed.data.ramo,
      campos: parsed.data.campos,
      porEmail: req.user?.email ?? null,
    });
    invalidarCachesMapeamento();
    const dados = await obterMapeamentoAdmin(parsed.data.provider, parsed.data.ramo, req.corretoraId!);
    res.json({ ok: true, ...dados });
  } catch (e) {
    logger.error("[mapper.routes] salvar schema falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "save_failed", mensagem: (e as Error).message });
  }
});

const patchConfigSchema = z.object({
  ativo: z.boolean(),
  provider: z.string().min(1).default(ALVO_PADRAO.provider),
  ramo: z.string().min(1).default(ALVO_PADRAO.ramo),
});

router.patch("/config", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const parsed = patchConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "corpo_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    await definirMapperDinamicoAtivo(req.corretoraId!, parsed.data.ativo, req.user?.email ?? null);
    const dados = await obterMapeamentoAdmin(parsed.data.provider, parsed.data.ramo, req.corretoraId!);
    res.json({ ok: true, ...dados });
  } catch (e) {
    logger.error("[mapper.routes] config falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "config_failed", mensagem: (e as Error).message });
  }
});

router.post("/regras/:id/aprovar", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) {
    res.status(422).json({ erro: "id_invalido" });
    return;
  }
  const { provider, ramo } = lerAlvo(req);
  try {
    await aprovarRegra(id.data, req.corretoraId!, req.user?.email ?? null);
    const dados = await obterMapeamentoAdmin(provider, ramo, req.corretoraId!);
    res.json({ ok: true, ...dados });
  } catch (e) {
    logger.error("[mapper.routes] aprovar falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "aprovar_failed", mensagem: (e as Error).message });
  }
});

router.post("/regras/:id/arquivar", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) {
    res.status(422).json({ erro: "id_invalido" });
    return;
  }
  const { provider, ramo } = lerAlvo(req);
  try {
    await arquivarRegra(id.data, req.corretoraId!);
    const dados = await obterMapeamentoAdmin(provider, ramo, req.corretoraId!);
    res.json({ ok: true, ...dados });
  } catch (e) {
    logger.error("[mapper.routes] arquivar falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "arquivar_failed", mensagem: (e as Error).message });
  }
});

export const mapeamentoRouter = router;
