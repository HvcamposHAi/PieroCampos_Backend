/**
 * Rotas HTTP das CREDENCIAIS do Segfy (Admin > Segfy). Admin-only.
 *   - GET   /api/segfy/credenciais         → status (NUNCA devolve a senha).
 *   - PATCH /api/segfy/credenciais {email,senha} → cifra e grava (conta única).
 *   - POST  /api/segfy/credenciais/testar  → login REAL no Segfy; registra ok/erro.
 *
 * A senha trafega só no PATCH (sob TLS) e é cifrada em repouso (cipher.ts). Nenhuma
 * rota loga o corpo. `exigirAdmin` é a defesa real (não confiar só na UI).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { exigirAdmin, exigirCorretoraSelecionada } from "../../middlewares/authSupabase";
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import {
  obterCredenciaisSegfy,
  registrarTesteSegfy,
  salvarCredenciaisSegfy,
  statusCredenciaisSegfy,
} from "../../services/segfy-credenciais.service";
import {
  avisoProativoSessao,
  confirmarReauth,
  importarSessao,
  iniciarReauth,
  invalidarSessao,
  restaurarSessao,
  statusSessao,
} from "../../services/segfy-sessao.service";
import { notificarReauthNecessaria } from "../../services/segfy-alertas.service";
import {
  atualizarSeguradora,
  listarSeguradorasConfig,
  sincronizarSeguradoras,
} from "../../services/segfy-seguradoras.service";
import { obterTokensSegfy } from "./segfy.multicalculo";

const router = Router();

router.get("/credenciais", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  try {
    // Status de credenciais (por-corretora) + status da SESSÃO confiável (2FA).
    const [status, sessao] = await Promise.all([
      statusCredenciaisSegfy(req.corretoraId!),
      statusSessao(),
    ]);
    res.json({ ok: true, ...status, sessao });
  } catch (e) {
    logger.error("[segfy.routes] status falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "status_failed", mensagem: (e as Error).message });
  }
});

const putSchema = z.object({
  email: z.string().trim().email("e-mail inválido"),
  senha: z.string().min(1, "senha obrigatória").max(200),
});

router.patch("/credenciais", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const parsed = putSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    await salvarCredenciaisSegfy({
      email: parsed.data.email,
      senha: parsed.data.senha,
      corretoraId: req.corretoraId!,
      porEmail: req.user?.email ?? null,
    });
    // Trocar a senha invalida a sessão confiável: força nova reauth coerente.
    await invalidarSessao();
    const [status, sessao] = await Promise.all([
      statusCredenciaisSegfy(req.corretoraId!),
      statusSessao(),
    ]);
    res.json({ ok: true, ...status, sessao });
  } catch (e) {
    logger.error("[segfy.routes] salvar falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "save_failed", mensagem: (e as Error).message });
  }
});

// ── Importação de sessão do navegador do operador (contorno do 2FA SEM browser) ─

const importarSchema = z.object({
  cookieHeader: z.string().trim().min(10, "cole o cabeçalho Cookie do Segfy").max(20_000),
  authAutomationToken: z.string().trim().min(10).max(8_000).optional(),
  userAutomationToken: z.string().trim().min(10).max(8_000).optional(),
});

router.post("/sessao/importar", exigirAdmin, async (req: Request, res: Response) => {
  const parsed = importarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ ok: false, erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    const { cookieHeader, authAutomationToken, userAutomationToken } = parsed.data;
    const tokens =
      authAutomationToken && userAutomationToken ? { authAutomationToken, userAutomationToken } : undefined;
    await importarSessao({ cookieHeader, tokens, porEmail: req.user?.email ?? null });
    const sessao = await statusSessao();
    res.json({ ok: true, sessao });
  } catch (e) {
    const msg = (e as Error).message;
    logger.error("[segfy.routes] importar sessão falhou", { erro: msg });
    res.status(500).json({ ok: false, erro: "importar_falhou", mensagem: msg });
  }
});

// ── Reautenticação assistida (contorno do 2FA) ───────────────────────────────

router.post("/sessao/iniciar", exigirAdmin, async (req: Request, res: Response) => {
  try {
    const r = await iniciarReauth({ porEmail: req.user?.email ?? null });
    res.json({ ok: true, ...r });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "sem_credenciais") {
      res.status(409).json({ ok: false, erro: "sem_credenciais", mensagem: "Cadastre o login e a senha do Segfy antes de reautenticar." });
      return;
    }
    if (msg === "scraping_desabilitado") {
      res.status(409).json({ ok: false, erro: "scraping_desabilitado", mensagem: "Reautenticação por navegador desativada (SEGFY_SCRAPING_ENABLED=false). Use 'Importar sessão' (cookie)." });
      return;
    }
    logger.error("[segfy.routes] iniciar reauth falhou", { erro: msg });
    res.status(500).json({ ok: false, erro: "reauth_iniciar_falhou", mensagem: msg });
  }
});

const confirmarSchema = z.object({
  challengeId: z.string().min(1),
  codigo: z.string().trim().min(4, "código inválido").max(12),
});

router.post("/sessao/confirmar", exigirAdmin, async (req: Request, res: Response) => {
  const parsed = confirmarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ ok: false, erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    await confirmarReauth(parsed.data);
    const sessao = await statusSessao();
    res.json({ ok: true, sessao });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "challenge_invalido") {
      res.status(409).json({ ok: false, erro: "challenge_invalido", mensagem: "Sessão de reautenticação expirou. Recomece pelo botão Reautenticar." });
      return;
    }
    if (msg === "scraping_desabilitado") {
      res.status(409).json({ ok: false, erro: "scraping_desabilitado", mensagem: "Reautenticação por navegador desativada (SEGFY_SCRAPING_ENABLED=false). Use 'Importar sessão' (cookie)." });
      return;
    }
    logger.warn("[segfy.routes] confirmar reauth falhou", { erro: msg });
    res.json({ ok: false, mensagem: msg });
  }
});

router.post("/credenciais/testar", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const creds = await obterCredenciaisSegfy(req.corretoraId!);
  if (!creds) {
    res.status(409).json({ ok: false, erro: "sem_credenciais", mensagem: "Cadastre o login e a senha antes de testar." });
    return;
  }
  try {
    // forcar=true → não usa cache; login de verdade com as credenciais salvas +
    // a SESSÃO importada (cookie de device trust) — espelha o caminho de cotação
    // e valida na hora se o cookie dispensa o 2FA (premissa P1′).
    const sessao = await restaurarSessao();
    await obterTokensSegfy(true, { email: creds.email, password: creds.password }, sessao ?? undefined);
    await registrarTesteSegfy(true, "Login OK", req.corretoraId!);
    res.json({ ok: true, mensagem: "Login no Segfy OK." });
  } catch (e) {
    const msg = (e as Error).message;
    await registrarTesteSegfy(false, msg, req.corretoraId!);
    logger.warn("[segfy.routes] teste de login falhou", { erro: msg });
    res.json({ ok: false, mensagem: msg });
  }
});

// ── Curadoria de seguradoras (quais cotar) ───────────────────────────────────

router.get("/seguradoras", exigirAdmin, async (_req: Request, res: Response) => {
  try {
    const seguradoras = await listarSeguradorasConfig();
    res.json({ ok: true, seguradoras });
  } catch (e) {
    logger.error("[segfy.routes] listar seguradoras falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "list_failed", mensagem: (e as Error).message });
  }
});

router.post("/seguradoras/sync", exigirAdmin, async (_req: Request, res: Response) => {
  try {
    const r = await sincronizarSeguradoras();
    const seguradoras = await listarSeguradorasConfig();
    res.json({ ok: true, ...r, seguradoras });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "sem_credenciais") {
      res.status(409).json({ ok: false, erro: "sem_credenciais", mensagem: "Cadastre o login e a senha do Segfy antes de sincronizar." });
      return;
    }
    logger.error("[segfy.routes] sync seguradoras falhou", { erro: msg });
    res.status(500).json({ erro: "sync_failed", mensagem: msg });
  }
});

const patchSeguradoraSchema = z.object({
  ativa: z.boolean().optional(),
  comissao: z.number().min(0).max(100).optional(),
});

router.patch("/seguradoras/:codigo", exigirAdmin, async (req: Request, res: Response) => {
  const codigo = (req.params.codigo ?? "").trim().toLowerCase();
  if (!codigo) {
    res.status(400).json({ erro: "codigo_invalido" });
    return;
  }
  const parsed = patchSeguradoraSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    await atualizarSeguradora(codigo, parsed.data);
    res.json({ ok: true });
  } catch (e) {
    logger.error("[segfy.routes] atualizar seguradora falhou", { erro: (e as Error).message });
    res.status(500).json({ erro: "update_failed", mensagem: (e as Error).message });
  }
});

export const segfyRouter = router;

/**
 * Router PÚBLICO (sem JWT) p/ o aviso PROATIVO de reautenticação, disparado por um
 * pinger externo. Protegido por token compartilhado (header `x-cron-token` ==
 * SEGFY_SESSAO_CRON_TOKEN). Token vazio → 404 (desabilitado). Mesma forma do
 * /api/aprendizado/cron. Sem corretora: a sessão Segfy é singleton da conta.
 */
const publico = Router();
publico.post("/", async (req: Request, res: Response) => {
  const token = getEnv().SEGFY_SESSAO_CRON_TOKEN;
  if (!token) {
    res.status(404).json({ erro: "cron_desabilitado" });
    return;
  }
  if (req.header("x-cron-token") !== token) {
    res.status(401).json({ erro: "token_invalido" });
    return;
  }
  try {
    const r = await avisoProativoSessao();
    if (r.avisar && r.motivo) await notificarReauthNecessaria(r.motivo);
    res.json({ ok: true, avisou: r.avisar });
  } catch (e) {
    logger.error("[segfy.routes] cron sessão falhou", { erro: (e as Error).message });
    res.status(500).json({ ok: false, erro: "cron_falhou", mensagem: (e as Error).message });
  }
});

export const segfySessaoCronRouter = publico;
