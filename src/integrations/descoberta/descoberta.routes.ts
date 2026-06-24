/**
 * Rotas HTTP do ADI.
 *
 * ADMIN (`descobertaRouter`, atrás de authSupabase+auditarMutacoes), admin-only:
 *   - GET    /                      → lista contratos + toggle exec_ativo.
 *   - GET    /:id                   → contrato detalhado + adapters.
 *   - POST   /descobrir             → cria job p/ o daemon OU ingere HAR direto.
 *   - POST   /:id/aprovar           → rascunho→aprovado.
 *   - POST   /adapter/:id/ativar    → ativa adapter (exige contrato aprovado).
 *   - PATCH  /config {exec_ativo}   → liga/desliga execução por adapter (corretora).
 *
 * AGENTE (`descobertaAgenteRouter`, token-gated, fora do authSupabase): o daemon
 * local pega o próximo job e devolve o HAR resumido (já redigido) p/ ingestão.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { exigirAdmin, exigirCorretoraSelecionada } from "../../middlewares/authSupabase";
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import { ingerirDescoberta } from "./descoberta.ingest";
import {
  aprovarContrato,
  ativarAdapter,
  criarJobConstrucao,
  criarJobDescoberta,
  definirExecAtivo,
  finalizarJob,
  lerExecAtivo,
  listarAdapters,
  listarAdaptersDaSeguradora,
  listarContratos,
  obterContrato,
  proximoJobConstrucao,
  proximoJobDescoberta,
  salvarAdapterValidado,
} from "./descoberta.persistence";

// ── Schemas ────────────────────────────────────────────────────────────────

const harEntradaSchema = z.object({
  metodo: z.string(),
  url: z.string(),
  status: z.number(),
  reqHeaders: z.record(z.string()).default({}),
  reqBody: z.unknown().optional(),
  respBody: z.unknown().optional(),
  respHeaders: z.record(z.string()).optional(),
});
const harResumoSchema = z.object({
  entradas: z.array(harEntradaSchema),
  domLinks: z.array(z.object({ texto: z.string(), href: z.string() })).optional(),
});
const domSchema = z.object({ markup: z.string().optional(), exigiu2fa: z.boolean().optional() }).optional();

const descobrirSchema = z.object({
  sistema: z.string().min(1),
  ramo: z.string().min(1),
  operacao: z.enum(["consulta", "cotacao", "apolice"]).default("cotacao"),
  url: z.string().url().optional(),
  ramosSuportados: z.array(z.string()).optional(),
  // ingestão DIRETA (testes/import manual): se vier `har`, processa na hora.
  har: harResumoSchema.optional(),
  dom: domSchema,
  estabilidade: z.enum(["estavel", "instavel"]).optional(),
});

// ── Router ADMIN ─────────────────────────────────────────────────────────────

const router = Router();

router.get("/", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  try {
    const [contratos, execAtivo] = await Promise.all([listarContratos(req.corretoraId!), lerExecAtivo(req.corretoraId!)]);
    res.json({ ok: true, contratos, execAtivo });
  } catch (e) {
    logger.error("[descoberta.routes] listar falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "get_failed", mensagem: (e as Error).message });
  }
});

router.get("/:id", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) {
    res.status(422).json({ erro: "id_invalido" });
    return;
  }
  try {
    const contrato = await obterContrato(req.corretoraId!, id.data);
    if (!contrato) {
      res.status(404).json({ erro: "nao_encontrado" });
      return;
    }
    const adapters = await listarAdapters(req.corretoraId!, id.data);
    res.json({ ok: true, contrato, adapters });
  } catch (e) {
    logger.error("[descoberta.routes] obter falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "get_failed", mensagem: (e as Error).message });
  }
});

router.post("/descobrir", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  if (!getEnv().DESCOBERTA_ENABLED) {
    res.status(409).json({ erro: "descoberta_desabilitada", mensagem: "Ligue DESCOBERTA_ENABLED e rode o agente local." });
    return;
  }
  const parsed = descobrirSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  try {
    if (d.har) {
      // ingestão direta (sem daemon) — útil p/ importar HAR já capturado
      const r = await ingerirDescoberta({
        corretoraId: req.corretoraId!,
        sistema: d.sistema,
        ramo: d.ramo,
        operacao: d.operacao,
        har: d.har,
        dom: d.dom,
        ramosSuportados: d.ramosSuportados,
        estabilidade: d.estabilidade,
      });
      res.json({ ok: true, modo: "ingestao_direta", contratoId: r.contratoId, adapterId: r.adapterId, versao: r.versao });
      return;
    }
    const { jobId } = await criarJobDescoberta(req.corretoraId!, d.sistema, d.ramo, {
      url: d.url,
      operacao: d.operacao,
      ramosSuportados: d.ramosSuportados,
    });
    res.json({ ok: true, modo: "job_enfileirado", jobId });
  } catch (e) {
    logger.error("[descoberta.routes] descobrir falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "descobrir_failed", mensagem: (e as Error).message });
  }
});

router.post("/:id/aprovar", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) {
    res.status(422).json({ erro: "id_invalido" });
    return;
  }
  try {
    await aprovarContrato(req.corretoraId!, id.data, req.user?.email ?? null);
    res.json({ ok: true });
  } catch (e) {
    logger.error("[descoberta.routes] aprovar falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "aprovar_failed", mensagem: (e as Error).message });
  }
});

router.post("/adapter/:id/ativar", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) {
    res.status(422).json({ erro: "id_invalido" });
    return;
  }
  try {
    await ativarAdapter(req.corretoraId!, id.data);
    res.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg === "contrato_nao_aprovado" ? 409 : msg === "adapter_nao_encontrado" ? 404 : 500;
    logger.error("[descoberta.routes] ativar falhou", { erro: msg });
    res.status(status).json({ erro: "ativar_failed", mensagem: msg });
  }
});

// ── v2: Construir RPA por objetivo (produtor) ───────────────────────────────

const construirSchema = z.object({
  seguradoraConfigId: z.string().uuid(),
  sistema: z.string().min(1),
  ramo: z.string().min(1).default("auto"),
  objetivo: z.enum(["validar_estrutura", "consulta", "cotacao", "apolice"]),
  url: z.string().url().optional(),
  casoTeste: z
    .object({
      dados: z.record(z.unknown()).optional(),
      propostaTeste: z.string().optional(),
      confirmaEmissaoReal: z.boolean().optional(),
    })
    .optional(),
});

router.post("/construir", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  if (!getEnv().DESCOBERTA_ENABLED) {
    res.status(409).json({ erro: "descoberta_desabilitada", mensagem: "Ligue DESCOBERTA_ENABLED e rode o agente local." });
    return;
  }
  const parsed = construirSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  // segurança: objetivo apólice emite de verdade no teste → exige confirmação
  if (d.objetivo === "apolice" && !d.casoTeste?.confirmaEmissaoReal) {
    res.status(409).json({ erro: "confirmacao_necessaria", mensagem: "Objetivo 'apólice' emite 1 apólice real de validação. Confirme com confirmaEmissaoReal." });
    return;
  }
  try {
    const { jobId } = await criarJobConstrucao(req.corretoraId!, {
      seguradoraConfigId: d.seguradoraConfigId,
      sistema: d.sistema,
      ramo: d.ramo,
      objetivo: d.objetivo,
      url: d.url,
      casoTeste: d.casoTeste,
    });
    res.json({ ok: true, jobId });
  } catch (e) {
    logger.error("[descoberta.routes] construir falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "construir_failed", mensagem: (e as Error).message });
  }
});

router.get("/seguradora/:id/adapters", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) {
    res.status(422).json({ erro: "id_invalido" });
    return;
  }
  try {
    const adapters = await listarAdaptersDaSeguradora(req.corretoraId!, id.data);
    res.json({ ok: true, adapters });
  } catch (e) {
    res.status(500).json({ erro: "get_failed", mensagem: (e as Error).message });
  }
});

const patchConfigSchema = z.object({ exec_ativo: z.boolean() });
router.patch("/config", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const parsed = patchConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "corpo_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    await definirExecAtivo(req.corretoraId!, parsed.data.exec_ativo, req.user?.email ?? null);
    res.json({ ok: true, execAtivo: parsed.data.exec_ativo });
  } catch (e) {
    logger.error("[descoberta.routes] config falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "config_failed", mensagem: (e as Error).message });
  }
});

export const descobertaRouter = router;

// ── Router AGENTE (daemon local, token-gated) ────────────────────────────────

const agente = Router();

function exigirTokenAgente(req: Request, res: Response): boolean {
  const token = getEnv().DESCOBERTA_AGENT_TOKEN;
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
    const job = await proximoJobDescoberta();
    res.json({ ok: true, job });
  } catch (e) {
    res.status(500).json({ ok: false, erro: "trabalho_falhou", mensagem: (e as Error).message });
  }
});

const reportarSchema = z.object({
  jobId: z.string().uuid(),
  corretoraId: z.string().uuid(),
  sistema: z.string().min(1),
  ramo: z.string().min(1),
  operacao: z.enum(["consulta", "cotacao", "apolice"]).default("cotacao"),
  har: harResumoSchema.nullable().optional(),
  dom: domSchema,
  ramosSuportados: z.array(z.string()).optional(),
  estabilidade: z.enum(["estavel", "instavel"]).optional(),
  harRef: z.string().nullable().optional(),
  erro: z.string().max(500).nullable().optional(),
});

agente.post("/reportar", async (req: Request, res: Response) => {
  if (!exigirTokenAgente(req, res)) return;
  const parsed = reportarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ ok: false, erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  try {
    if (d.erro || !d.har) {
      await finalizarJob(d.jobId, { status: "erro", etapa: "captura", erro: d.erro ?? "sem_har", harRef: d.harRef ?? null });
      res.json({ ok: true, status: "erro" });
      return;
    }
    const r = await ingerirDescoberta({
      corretoraId: d.corretoraId,
      sistema: d.sistema,
      ramo: d.ramo,
      operacao: d.operacao,
      har: d.har,
      dom: d.dom,
      ramosSuportados: d.ramosSuportados,
      estabilidade: d.estabilidade,
    });
    await finalizarJob(d.jobId, { status: "ok", etapa: "ingerido", contratoId: r.contratoId, harRef: d.harRef ?? null });
    res.json({ ok: true, status: "ok", contratoId: r.contratoId, adapterId: r.adapterId });
  } catch (e) {
    await finalizarJob(d.jobId, { status: "erro", etapa: "ingestao", erro: (e as Error).message });
    res.status(500).json({ ok: false, erro: "reportar_falhou", mensagem: (e as Error).message });
  }
});

// ── v2: construção (daemon roda o loop e reporta o adapter VALIDADO) ──────────

agente.get("/construcao/trabalho", async (req: Request, res: Response) => {
  if (!exigirTokenAgente(req, res)) return;
  try {
    const job = await proximoJobConstrucao();
    res.json({ ok: true, job });
  } catch (e) {
    res.status(500).json({ ok: false, erro: "trabalho_falhou", mensagem: (e as Error).message });
  }
});

const reportarConstrucaoSchema = z.object({
  jobId: z.string().uuid(),
  corretoraId: z.string().uuid(),
  seguradoraConfigId: z.string().uuid(),
  sistema: z.string().min(1),
  ramo: z.string().min(1).default("auto"),
  objetivo: z.enum(["validar_estrutura", "consulta", "cotacao", "apolice"]),
  status: z.enum(["validado", "requer_humano", "erro", "nao_suporta"]),
  spec: z.record(z.unknown()).nullable().optional(),
  casoTeste: z.unknown().optional(),
  criterioSucesso: z.unknown().optional(),
  url: z.string().nullable().optional(),
  erro: z.string().max(800).nullable().optional(),
});

agente.post("/construcao/reportar", async (req: Request, res: Response) => {
  if (!exigirTokenAgente(req, res)) return;
  const parsed = reportarConstrucaoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ ok: false, erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  try {
    if (d.status === "validado" && d.spec) {
      const { adapterId } = await salvarAdapterValidado(d.corretoraId, {
        seguradoraConfigId: d.seguradoraConfigId,
        sistema: d.sistema,
        ramo: d.ramo,
        objetivo: d.objetivo,
        spec: d.spec as never,
        casoTeste: d.casoTeste,
        criterioSucesso: d.criterioSucesso,
        url: d.url ?? null,
      });
      await finalizarJob(d.jobId, { status: "ok", etapa: "validado", resumo: { adapterId } });
      res.json({ ok: true, status: "validado", adapterId });
      return;
    }
    await finalizarJob(d.jobId, { status: d.status === "erro" ? "erro" : "andamento", etapa: d.status, erro: d.erro ?? null });
    res.json({ ok: true, status: d.status });
  } catch (e) {
    await finalizarJob(d.jobId, { status: "erro", etapa: "persistir", erro: (e as Error).message });
    res.status(500).json({ ok: false, erro: "reportar_falhou", mensagem: (e as Error).message });
  }
});

export const descobertaAgenteRouter = agente;
