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
import {
  exigirAdmin,
  exigirCorretoraSelecionada,
  carregarOperadorAtivo,
} from "../../middlewares/authSupabase";
import { logger } from "../../utils/logger";
import { getEnv } from "../../config/env";
import {
  obterConfigAdmin,
  obterEssencialLinha,
  removerOverride,
  salvarConfig,
  salvarConfigEssencialLinha,
} from "../../services/agente-config.service";
import { gerarEstilo } from "../../services/estilo-clone.service";

const router = Router();

router.get("/config", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  try {
    const dados = await obterConfigAdmin(req.corretoraId!);
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
  // Mapas por categoria → ARRAY (legado, vale p/ todos os sistemas) OU objeto
  // por SISTEMA `{segfy:[...], aggilizador:[...]}`. O serviço saneia (descarta
  // obrigatórios / chaves inválidas / valida cada fatia por sistema).
  campos_excluidos: z
    .record(z.string(), z.union([z.array(z.string()), z.record(z.string(), z.array(z.string()))]))
    .optional(),
  perguntas_customizadas: z
    .record(
      z.string(),
      z.union([z.array(perguntaCustomSchema), z.record(z.string(), z.array(perguntaCustomSchema))]),
    )
    .optional(),
  ativo: z.boolean().optional(),
});

router.put("/config", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const parsed = putSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    await salvarConfig({
      corretoraId: req.corretoraId!,
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
    const dados = await obterConfigAdmin(req.corretoraId!);
    res.json({ ok: true, ...dados });
  } catch (e) {
    logger.error("[agente.routes] salvar falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "save_failed", mensagem: (e as Error).message });
  }
});

router.delete("/config/:canalId", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const canalId = z.string().uuid().safeParse(req.params.canalId);
  if (!canalId.success) {
    res.status(422).json({ erro: "canal_invalido" });
    return;
  }
  try {
    await removerOverride(canalId.data, req.corretoraId!);
    const dados = await obterConfigAdmin(req.corretoraId!);
    res.json({ ok: true, ...dados });
  } catch (e) {
    logger.error("[agente.routes] remover override falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "delete_failed", mensagem: (e as Error).message });
  }
});

// ---------------------------------------------------------------------------
// GERAÇÃO ASSISTIDA do campo `estilo_amostra` (Admin > Bia > "Clonar estilo").
// Colhe mensagens reais do operador (linha) OU texto colado OU .txt, redige PII e
// destila um perfil de estilo via Claude — para o admin REVISAR e salvar. Não
// persiste nada (o save continua no PUT /config). Gated por ESTILO_CLONE_ENABLED:
// off → 404 (recurso inerte, campo segue editável manualmente). Read-only no banco.
// ---------------------------------------------------------------------------
const gerarEstiloSchema = z.object({
  fonte: z.enum(["linha", "texto", "arquivo"]),
  canal_id: z.string().uuid().nullable().optional(),
  texto: z.string().max(200_000).optional(),
  // .txt em base64; teto generoso (decodificado ainda é limitado a 200KB no serviço).
  arquivo_base64: z.string().max(400_000).optional(),
  // Export do WhatsApp com vários remetentes: nome de quem é o operador a clonar.
  remetente_operador: z.string().max(80).optional(),
});

router.post("/estilo/gerar", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  if (!getEnv().ESTILO_CLONE_ENABLED) {
    res.status(404).json({ erro: "estilo_clone_desabilitado" });
    return;
  }
  const parsed = gerarEstiloSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    const r = await gerarEstilo({
      corretoraId: req.corretoraId!,
      fonte: parsed.data.fonte,
      canalId: parsed.data.canal_id ?? null,
      texto: parsed.data.texto,
      arquivoBase64: parsed.data.arquivo_base64,
      remetenteOperador: parsed.data.remetente_operador,
    });
    res.json({
      ok: true,
      amostra: r.amostra,
      n_linhas_fonte: r.nLinhasFonte,
      precisa_remetente: r.precisaRemetente ?? false,
      remetentes: r.remetentes ?? [],
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "destilacao_indisponivel") {
      res.status(502).json({ erro: "destilacao_indisponivel", mensagem: "Não foi possível gerar o estilo agora. Tente novamente." });
      return;
    }
    logger.error("[agente.routes] gerar estilo falhou", { erro: msg });
    res.status(500).json({ erro: "estilo_failed", mensagem: msg });
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
      corretoraId: op.corretora_id,
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
