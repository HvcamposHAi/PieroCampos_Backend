/**
 * Rotas HTTP do CATÁLOGO de seguradoras + EMISSÃO de apólice (Admin > Seguradoras).
 * Admin-only e multi-tenant (exigirAdmin + exigirCorretoraSelecionada → req.corretoraId).
 *
 *   GET   /api/apolice/seguradoras                  → lista (tela /seguradoras)
 *   PATCH /api/apolice/seguradoras/:id              → edita config (Config)
 *   PATCH /api/apolice/seguradoras/:id/credenciais  → grava login/senha CIFRADOS (Senha)
 *   POST  /api/apolice/seguradoras/:id/testar       → login de verificação → status (Testar)
 *   POST  /api/apolice/propostas/:propostaId/gerar  → emite a apólice (202 + background)
 *
 * Gate mestre: APOLICE_ENABLED. Off → /gerar e /testar respondem 409 e não tocam portal.
 * Nenhuma rota loga corpo; a senha trafega só no PATCH (TLS) e é cifrada em repouso.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { exigirAdmin, exigirCorretoraSelecionada } from "../../middlewares/authSupabase";
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import {
  atualizarSeguradoraConfig,
  listarSeguradorasConfig,
  testarConectividade,
} from "../../services/seguradoras-config.service";
import { salvarCredenciaisPortal } from "../../services/seguradora-credenciais.service";
import { atualizarStatusProposta, criarPropostaDeCotacao } from "../../services/propostas.service";
import { agenteReportar, enfileirar, pegarProximoTrabalho, statusJob } from "../../services/apolice-job.service";
import { arquivarRegraPortal, aprovarRegraPortal, listarRegrasPortal } from "./llm/portal-admin.service";

// `testarConectividade`/`emitirApolice` NÃO são mais chamados aqui (rodavam o
// Chromium no Render → erro). Agora as rotas ENFILEIRAM um job; o AGENTE LOCAL
// (apolice-agent) executa esses serviços na máquina do operador e reporta.
const router = Router();

const STATUS_PROPOSTA = [
  "pendente",
  "transmitida",
  "em_analise",
  "pendencia_doc",
  "pendencia_vistoria",
  "problema_bonificacao",
  "recusada",
  "aprovada",
  "emitida",
] as const;

router.get("/seguradoras", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  try {
    const seguradoras = await listarSeguradorasConfig(req.corretoraId!);
    res.json({ ok: true, seguradoras });
  } catch (e) {
    logger.error("[apolice.routes] listar falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "listar_falhou", mensagem: (e as Error).message });
  }
});

const patchSchema = z.object({
  ativo: z.boolean().optional(),
  grupo_integracao: z.enum(["A_api", "B_rpa", "C_otp"]).optional(),
  tipo_autenticacao: z.string().max(120).nullable().optional(),
  login_type: z.string().max(120).nullable().optional(),
  url_portal: z.string().url().max(500).nullable().optional(),
  email_otp: z.string().email().max(200).nullable().optional(),
  observacao_tecnica: z.string().max(1000).nullable().optional(),
});

router.patch("/seguradoras/:id", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const id = req.params.id ?? "";
  const parsed = patchSchema.safeParse(req.body);
  if (!id || !parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.success ? "id" : parsed.error.flatten() });
    return;
  }
  try {
    await atualizarSeguradoraConfig(req.corretoraId!, id, parsed.data);
    res.json({ ok: true });
  } catch (e) {
    logger.error("[apolice.routes] atualizar falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "atualizar_falhou", mensagem: (e as Error).message });
  }
});

const credSchema = z.object({
  usuario: z.string().trim().min(1, "usuário obrigatório").max(200),
  senha: z.string().min(1, "senha obrigatória").max(400),
  extra: z.record(z.string()).optional(),
});

router.patch("/seguradoras/:id/credenciais", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const id = req.params.id ?? "";
  const parsed = credSchema.safeParse(req.body);
  if (!id || !parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.success ? "id" : parsed.error.flatten() });
    return;
  }
  try {
    await salvarCredenciaisPortal({
      seguradoraConfigId: id,
      corretoraId: req.corretoraId!,
      usuario: parsed.data.usuario,
      senha: parsed.data.senha,
      extra: parsed.data.extra,
      porEmail: req.user?.email ?? null,
    });
    res.json({ ok: true });
  } catch (e) {
    logger.error("[apolice.routes] salvar credenciais falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "salvar_falhou", mensagem: (e as Error).message });
  }
});

router.post("/seguradoras/:id/testar", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const id = req.params.id ?? "";
  if (!id) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  if (!getEnv().APOLICE_ENABLED) {
    res.status(409).json({ ok: false, erro: "apolice_desabilitado", mensagem: "Geração/teste de apólice desativada (APOLICE_ENABLED=false)." });
    return;
  }
  try {
    // ENFILEIRA (não roda o navegador no servidor). O agente local executa e o
    // status chega à tela via realtime (registrarStatusAcesso). 202 + jobId.
    const r = await enfileirar({ tipo: "testar", alvo: id, corretoraId: req.corretoraId!, por: req.user?.email ?? null });
    res.status(202).json({ ok: true, ...r });
  } catch (e) {
    logger.error("[apolice.routes] enfileirar teste falhou", { erro: (e as Error).message });
    res.status(500).json({ ok: false, erro: "testar_falhou", mensagem: (e as Error).message });
  }
});

/** Status de um job (polling da UI). NUNCA devolve o código 2FA. */
router.get("/jobs/:id", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const id = req.params.id ?? "";
  if (!id) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  try {
    res.json({ ok: true, ...(await statusJob(id)) });
  } catch (e) {
    res.status(500).json({ ok: false, erro: "status_falhou", mensagem: (e as Error).message });
  }
});

// ── Ciclo de vida da proposta (pré-requisito do "Gerar apólice") ─────────────

const criarPropostaSchema = z.object({
  cotacaoId: z.string().uuid("cotacaoId inválido"),
  seguradora: z.string().trim().min(1).max(200).optional(),
  numeroProposta: z.string().trim().max(120).nullable().optional(),
});

router.post("/propostas", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const parsed = criarPropostaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    const r = await criarPropostaDeCotacao({
      corretoraId: req.corretoraId!,
      cotacaoId: parsed.data.cotacaoId,
      seguradora: parsed.data.seguradora,
      numeroProposta: parsed.data.numeroProposta ?? null,
      operadorId: req.operador?.id ?? null,
    });
    res.status(201).json({ ok: true, ...r });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "cotacao_nao_encontrada" || msg === "seguradora_obrigatoria") {
      res.status(422).json({ ok: false, erro: msg });
      return;
    }
    logger.error("[apolice.routes] criar proposta falhou", { erro: msg });
    res.status(500).json({ ok: false, erro: "criar_proposta_falhou", mensagem: msg });
  }
});

const statusPropostaSchema = z.object({ status: z.enum(STATUS_PROPOSTA) });

router.patch("/propostas/:propostaId/status", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const propostaId = req.params.propostaId ?? "";
  const parsed = statusPropostaSchema.safeParse(req.body);
  if (!propostaId || !parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.success ? "id" : parsed.error.flatten() });
    return;
  }
  try {
    await atualizarStatusProposta({ corretoraId: req.corretoraId!, propostaId, status: parsed.data.status });
    res.json({ ok: true });
  } catch (e) {
    logger.error("[apolice.routes] atualizar status proposta falhou", { erro: (e as Error).message });
    res.status(500).json({ ok: false, erro: "atualizar_status_falhou", mensagem: (e as Error).message });
  }
});

router.post("/propostas/:propostaId/gerar", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const propostaId = req.params.propostaId ?? "";
  if (!propostaId) {
    res.status(400).json({ erro: "id_invalido" });
    return;
  }
  if (!getEnv().APOLICE_ENABLED) {
    res.status(409).json({ ok: false, erro: "apolice_desabilitado", mensagem: "Geração de apólice desativada (APOLICE_ENABLED=false)." });
    return;
  }
  try {
    // ENFILEIRA a emissão; o agente local roda o navegador e persiste. 202 + jobId.
    const r = await enfileirar({ tipo: "emitir", alvo: propostaId, corretoraId: req.corretoraId!, por: req.user?.email ?? null });
    res.status(202).json({ ok: true, ...r });
  } catch (e) {
    logger.error("[apolice.routes] enfileirar emissão falhou", { erro: (e as Error).message });
    res.status(500).json({ ok: false, erro: "gerar_falhou", mensagem: (e as Error).message });
  }
});

// ── Curadoria das regras de seletor de portal (LLM) — Admin ──────────────────

router.get("/portais/regras", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  try {
    res.json({ ok: true, regras: await listarRegrasPortal(req.corretoraId!) });
  } catch (e) {
    res.status(500).json({ ok: false, erro: "listar_regras_falhou", mensagem: (e as Error).message });
  }
});

router.post("/portais/regras/:id/aprovar", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  try {
    await aprovarRegraPortal(req.params.id ?? "", req.corretoraId!, req.user?.email ?? null);
    res.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    res.status(msg === "regra_nao_encontrada" ? 404 : 500).json({ ok: false, erro: msg });
  }
});

router.post("/portais/regras/:id/arquivar", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  try {
    await arquivarRegraPortal(req.params.id ?? "", req.corretoraId!);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, erro: "arquivar_falhou", mensagem: (e as Error).message });
  }
});

export const apoliceRouter = router;

// ── Router PÚBLICO do AGENTE LOCAL (token-gated, fora do authSupabase) ────────
// Espelha segfySessaoTokensRouter: o daemon na máquina do operador (atrás de NAT)
// faz polling com `x-cron-token` = APOLICE_AGENT_TOKEN. Vazio → 404 (desabilitado).
const agente = Router();

function exigirTokenAgente(req: Request, res: Response): boolean {
  const token = getEnv().APOLICE_AGENT_TOKEN;
  if (!token) {
    res.status(404).json({ erro: "rota_nao_encontrada" });
    return false;
  }
  if (req.header("x-cron-token") !== token) {
    res.status(401).json({ erro: "token_invalido" });
    return false;
  }
  return true;
}

agente.get("/trabalho", async (req: Request, res: Response) => {
  if (!exigirTokenAgente(req, res)) return;
  try {
    const job = await pegarProximoTrabalho();
    res.json({ ok: true, job });
  } catch (e) {
    res.status(500).json({ ok: false, erro: "trabalho_falhou", mensagem: (e as Error).message });
  }
});

const reportarSchema = z.object({
  jobId: z.string().min(1),
  fase: z.enum(["aguardando_codigo", "concluida", "erro"]),
  resultado: z.record(z.unknown()).nullable().optional(),
  mensagem: z.string().max(500).nullable().optional(),
});

agente.post("/reportar", async (req: Request, res: Response) => {
  if (!exigirTokenAgente(req, res)) return;
  const parsed = reportarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ ok: false, erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    const ok = await agenteReportar(parsed.data);
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ ok: false, erro: "reportar_falhou", mensagem: (e as Error).message });
  }
});

export const apoliceAgenteRouter = agente;
