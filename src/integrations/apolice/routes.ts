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
import { emitirApolice } from "../../services/apolice-emissao.service";
import { atualizarStatusProposta, criarPropostaDeCotacao } from "../../services/propostas.service";

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
    const r = await testarConectividade(req.corretoraId!, id);
    res.json(r);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "seguradora_nao_encontrada") {
      res.status(404).json({ ok: false, erro: msg });
      return;
    }
    if (msg === "apolice_rpa_desabilitado") {
      res.status(409).json({ ok: false, erro: msg, mensagem: "Teste por navegador desativado (APOLICE_RPA_ENABLED=false)." });
      return;
    }
    logger.error("[apolice.routes] testar falhou", { erro: msg });
    res.status(500).json({ ok: false, erro: "testar_falhou", mensagem: msg });
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
  const corretoraId = req.corretoraId!;
  // 202 imediato — emissão (RPA/API) é lenta; tela acompanha via realtime (cotacao_eventos).
  res.status(202).json({ ok: true, mensagem: "emissao_iniciada" });
  void emitirApolice({ propostaId, corretoraId, operadorEmail: req.user?.email ?? null })
    .then((r) => {
      if ("erro" in r) logger.warn("[apolice.routes] emissão concluiu com erro", { propostaId, erro: r.erro });
    })
    .catch((e) => {
      logger.error("[apolice.routes] emissão lançou", { propostaId, erro: (e as Error).message });
    });
});

export const apoliceRouter = router;
