/**
 * Rotas HTTP da CONFIGURAÇÃO de comportamento da Bia (Admin > Bia). Admin-only.
 *   - GET    /api/agente/config              → padrão + override de cada linha.
 *   - PUT    /api/agente/config {canal_id,…} → salva padrão (canal_id null) ou override.
 *   - DELETE /api/agente/config/:canalId     → remove o override (volta ao padrão).
 *
 * Só ajusta ESTILO (tom/persona/saudação/exemplos/criatividade) — nunca as
 * regras absolutas de compliance. `exigirAdmin` é a defesa real (não a UI).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { exigirAdmin, carregarOperadorAtivo } from "../../middlewares/authSupabase";
import { logger } from "../../utils/logger";
import {
  obterConfigAdmin,
  obterEssencialLinha,
  removerOverride,
  salvarConfig,
  salvarConfigEssencialLinha,
} from "../../services/agente-config.service";

const router = Router();

router.get("/config", exigirAdmin, async (_req: Request, res: Response) => {
  try {
    const dados = await obterConfigAdmin();
    res.json({ ok: true, ...dados });
  } catch (e) {
    logger.error("[agente.routes] obter falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "get_failed", mensagem: (e as Error).message });
  }
});

const perguntaCustomSchema = z.object({
  id: z.string().max(80).optional(),
  chave: z.string().regex(/^custom_[a-z0-9_]{1,40}$/, "chave custom inválida"),
  pergunta: z.string().trim().min(1).max(200),
  dica: z.string().trim().max(200).nullish(),
});

const putSchema = z.object({
  canal_id: z.string().uuid().nullable(),
  tom_voz: z.enum(["proximo_caloroso", "formal_profissional", "direto_objetivo", "entusiasta"]),
  persona: z.string().trim().max(4000).nullish(),
  saudacao: z.string().trim().max(500).nullish(),
  exemplos: z.string().trim().max(4000).nullish(),
  variar_texto: z.boolean(),
  criatividade: z.enum(["consistente", "equilibrado", "criativo"]),
  objetivo: z.enum(["cotacao", "atendimento", "aquecer", "venda"]),
  emojis: z.enum(["sem", "moderado", "a_vontade"]).default("moderado"),
  estilo_amostra: z.string().trim().max(8000).nullish(),
  // Mapas por categoria; o serviço saneia (descarta obrigatórios / chaves inválidas).
  campos_excluidos: z.record(z.string(), z.array(z.string())).optional(),
  perguntas_customizadas: z.record(z.string(), z.array(perguntaCustomSchema)).optional(),
  ativo: z.boolean().optional(),
});

router.put("/config", exigirAdmin, async (req: Request, res: Response) => {
  const parsed = putSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    await salvarConfig({
      canalId: parsed.data.canal_id,
      tom_voz: parsed.data.tom_voz,
      persona: parsed.data.persona ?? null,
      saudacao: parsed.data.saudacao ?? null,
      exemplos: parsed.data.exemplos ?? null,
      variar_texto: parsed.data.variar_texto,
      criatividade: parsed.data.criatividade,
      objetivo: parsed.data.objetivo,
      emojis: parsed.data.emojis,
      estilo_amostra: parsed.data.estilo_amostra ?? null,
      campos_excluidos: parsed.data.campos_excluidos,
      perguntas_customizadas: parsed.data.perguntas_customizadas,
      ativo: parsed.data.ativo,
      porEmail: req.user?.email ?? null,
    });
    const dados = await obterConfigAdmin();
    res.json({ ok: true, ...dados });
  } catch (e) {
    logger.error("[agente.routes] salvar falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "save_failed", mensagem: (e as Error).message });
  }
});

router.delete("/config/:canalId", exigirAdmin, async (req: Request, res: Response) => {
  const canalId = z.string().uuid().safeParse(req.params.canalId);
  if (!canalId.success) {
    res.status(422).json({ erro: "canal_invalido" });
    return;
  }
  try {
    await removerOverride(canalId.data);
    const dados = await obterConfigAdmin();
    res.json({ ok: true, ...dados });
  } catch (e) {
    logger.error("[agente.routes] remover override falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "delete_failed", mensagem: (e as Error).message });
  }
});

// ---------------------------------------------------------------------------
// SELF-SERVICE do OPERADOR (app móvel /bot) — só os campos ESSENCIAIS da SUA
// linha (operadores.canal_padrao_id). NÃO é admin: usa carregarOperadorAtivo.
// Nunca toca o padrão nem outra linha; o save preserva os campos avançados do
// admin (campos da cotação / mensagens) via salvarConfigEssencialLinha.
// ---------------------------------------------------------------------------
const meSchema = z.object({
  objetivo: z.enum(["cotacao", "atendimento", "aquecer", "venda"]),
  tom_voz: z.enum(["proximo_caloroso", "formal_profissional", "direto_objetivo", "entusiasta"]),
  criatividade: z.enum(["consistente", "equilibrado", "criativo"]),
  persona: z.string().trim().max(4000).nullish(),
  saudacao: z.string().trim().max(500).nullish(),
});

router.get("/config/me", async (req: Request, res: Response) => {
  const op = await carregarOperadorAtivo(req);
  if (!op) {
    res.status(403).json({ erro: "operador_required" });
    return;
  }
  if (!op.canal_padrao_id) {
    res.status(409).json({ erro: "sem_linha" });
    return;
  }
  try {
    const essencial = await obterEssencialLinha(op.canal_padrao_id);
    res.json({ ok: true, ...essencial });
  } catch (e) {
    logger.error("[agente.routes] me.get falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "get_failed", mensagem: (e as Error).message });
  }
});

router.put("/config/me", async (req: Request, res: Response) => {
  const op = await carregarOperadorAtivo(req);
  if (!op) {
    res.status(403).json({ erro: "operador_required" });
    return;
  }
  if (!op.canal_padrao_id) {
    res.status(409).json({ erro: "sem_linha" });
    return;
  }
  const parsed = meSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    await salvarConfigEssencialLinha({
      canalId: op.canal_padrao_id,
      patch: {
        objetivo: parsed.data.objetivo,
        tom_voz: parsed.data.tom_voz,
        criatividade: parsed.data.criatividade,
        persona: parsed.data.persona ?? null,
        saudacao: parsed.data.saudacao ?? null,
      },
      porEmail: req.user?.email ?? null,
    });
    const essencial = await obterEssencialLinha(op.canal_padrao_id);
    res.json({ ok: true, ...essencial });
  } catch (e) {
    logger.error("[agente.routes] me.put falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "save_failed", mensagem: (e as Error).message });
  }
});

export const agenteRouter = router;
