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
  lerSistemaCotacao,
  obterCredenciaisSegfy,
  registrarTesteSegfy,
  salvarCredenciaisSegfy,
  statusCredenciaisSegfy,
} from "../../services/segfy-credenciais.service";
import { getSistema, SISTEMA_PADRAO } from "../quote/sistemas.catalog";
import {
  avisoProativoSessao,
  conexaoUtilizavel,
  confirmarReauth,
  gravarTokensHarvest,
  importarSessao,
  iniciarReauth,
  invalidarSessao,
  statusSessao,
} from "../../services/segfy-sessao.service";
import { notificarReauthNecessaria } from "../../services/segfy-alertas.service";
import {
  agenteReportar,
  enviarCodigoReauth,
  pegarTrabalhoReauth,
  solicitarReauth,
  statusReauth,
} from "../../services/segfy-reauth-orq.service";
import {
  atualizarSeguradora,
  listarSeguradorasConfig,
  sincronizarSeguradoras,
} from "../../services/segfy-seguradoras.service";

const router = Router();

// Status de CONEXÃO da sessão Segfy — acessível ao OPERADOR (não só admin): a
// cotação manual checa isto ANTES de disparar. Só leitura (sem hit no Segfy).
router.get("/sessao/status", async (_req: Request, res: Response) => {
  try {
    const r = await conexaoUtilizavel();
    res.json({ ok: true, ...r });
  } catch (e) {
    // fail-open: não bloqueia a cotação se o próprio check falhar.
    logger.warn("[segfy.routes] sessao/status falhou; fail-open", { erro: (e as Error).message });
    res.json({ ok: true, conectado: true, status: "ausente", valida_ate: null });
  }
});

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

// ── Reautenticação 1-clique via AGENTE LOCAL (2FA dentro do app, sem browser no
//    servidor). O admin solicita/digita o código aqui; a máquina local (token-gated,
//    routers públicos abaixo) abre o navegador e aplica o código. ───────────────

router.post("/sessao/reauth/solicitar", exigirAdmin, async (req: Request, res: Response) => {
  try {
    const r = await solicitarReauth(req.user?.email ?? null);
    res.json({ ok: true, ...r });
  } catch (e) {
    logger.error("[segfy.routes] solicitar reauth falhou", { erro: (e as Error).message });
    res.status(500).json({ ok: false, erro: "reauth_solicitar_falhou", mensagem: (e as Error).message });
  }
});

const codigoSchema = z.object({
  jobId: z.string().min(1),
  codigo: z.string().trim().min(4, "código inválido").max(12),
});

router.post("/sessao/reauth/codigo", exigirAdmin, async (req: Request, res: Response) => {
  const parsed = codigoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ ok: false, erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    const r = await enviarCodigoReauth(parsed.data);
    if (!r.ok) {
      res.status(409).json({ ok: false, erro: r.erro, mensagem: "Sessão de reautenticação inválida ou expirada. Recomece." });
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    logger.error("[segfy.routes] enviar código reauth falhou", { erro: (e as Error).message });
    res.status(500).json({ ok: false, erro: "reauth_codigo_falhou", mensagem: (e as Error).message });
  }
});

router.get("/sessao/reauth/status", async (req: Request, res: Response) => {
  try {
    const jobId = typeof req.query.jobId === "string" ? req.query.jobId : undefined;
    const r = await statusReauth(jobId);
    res.json({ ok: true, ...r });
  } catch (e) {
    logger.warn("[segfy.routes] status reauth falhou", { erro: (e as Error).message });
    res.json({ ok: true, fase: "idle", mensagem: null, email: null });
  }
});

router.post("/credenciais/testar", exigirAdmin, exigirCorretoraSelecionada, async (req: Request, res: Response) => {
  const creds = await obterCredenciaisSegfy(req.corretoraId!);
  if (!creds) {
    res.status(409).json({ ok: false, erro: "sem_credenciais", mensagem: "Cadastre o login e a senha antes de testar." });
    return;
  }
  // O teste segue o SISTEMA da corretora via CATÁLOGO único (cada sistema sabe se
  // testar). Sem isso, uma corretora Aggilizador testava no Firebase do Segfy e
  // dava 400 (falso-negativo). Independe do AGGILIZADOR_ENABLED — validar
  // credencial não exige a cotação ligada. Sistema desconhecido → Segfy (padrão).
  const sistema = await lerSistemaCotacao(req.corretoraId!);
  const def = getSistema(sistema) ?? getSistema(SISTEMA_PADRAO)!;
  try {
    const mensagem = await def.testarConexao({ email: creds.email, password: creds.password });
    await registrarTesteSegfy(true, mensagem, req.corretoraId!);
    res.json({ ok: true, mensagem });
  } catch (e) {
    const msg = (e as Error).message;
    await registrarTesteSegfy(false, msg, req.corretoraId!);
    logger.warn("[segfy.routes] teste de login falhou", { erro: msg, sistema });
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

/**
 * Router PÚBLICO p/ o AGENTE LOCAL de colheita: recebe os tokens de automação
 * colhidos do navegador com perfil persistente confiável (contorno de 2FA SEM
 * navegador no servidor — solução gratuita). Token compartilhado (x-cron-token).
 */
const publicoTokens = Router();
const tokensSchema = z.object({
  authAutomationToken: z.string().trim().min(10).max(8_000),
  userAutomationToken: z.string().trim().min(10).max(8_000),
});
publicoTokens.post("/", async (req: Request, res: Response) => {
  const token = getEnv().SEGFY_SESSAO_CRON_TOKEN;
  if (!token) {
    res.status(404).json({ erro: "cron_desabilitado" });
    return;
  }
  if (req.header("x-cron-token") !== token) {
    res.status(401).json({ erro: "token_invalido" });
    return;
  }
  const parsed = tokensSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ ok: false, erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    const ok = await gravarTokensHarvest(parsed.data);
    res.json({ ok });
  } catch (e) {
    logger.error("[segfy.routes] gravar tokens colhidos falhou", { erro: (e as Error).message });
    res.status(500).json({ ok: false, erro: "gravar_falhou", mensagem: (e as Error).message });
  }
});

export const segfySessaoTokensRouter = publicoTokens;

/**
 * Router PÚBLICO p/ o AGENTE LOCAL conduzir a reautenticação 1-clique (token-gated,
 * x-cron-token). O agente faz POLL de `/trabalho` (pega o job e, quando houver, o
 * código 2FA digitado no app) e reporta progresso/fim em `/reportar`. Só o agente
 * (token) vê o código — a UI nunca o recebe.
 */
const publicoReauth = Router();
function autorizadoCron(req: Request, res: Response): boolean {
  const token = getEnv().SEGFY_SESSAO_CRON_TOKEN;
  if (!token) {
    res.status(404).json({ erro: "cron_desabilitado" });
    return false;
  }
  if (req.header("x-cron-token") !== token) {
    res.status(401).json({ erro: "token_invalido" });
    return false;
  }
  return true;
}

publicoReauth.get("/trabalho", async (req: Request, res: Response) => {
  if (!autorizadoCron(req, res)) return;
  try {
    const job = await pegarTrabalhoReauth();
    res.json({ ok: true, job });
  } catch (e) {
    logger.error("[segfy.routes] pegar trabalho reauth falhou", { erro: (e as Error).message });
    res.status(500).json({ ok: false, erro: "trabalho_falhou" });
  }
});

const reportarSchema = z.object({
  jobId: z.string().min(1),
  fase: z.enum(["aguardando_codigo", "concluida", "erro"]),
  mensagem: z.string().max(500).optional(),
  email: z.string().max(200).optional(),
});

publicoReauth.post("/reportar", async (req: Request, res: Response) => {
  if (!autorizadoCron(req, res)) return;
  const parsed = reportarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ ok: false, erro: "input_invalido", detalhe: parsed.error.flatten() });
    return;
  }
  try {
    const ok = await agenteReportar(parsed.data);
    res.json({ ok });
  } catch (e) {
    logger.error("[segfy.routes] reportar reauth falhou", { erro: (e as Error).message });
    res.status(500).json({ ok: false, erro: "reportar_falhou" });
  }
});

export const segfySessaoReauthRouter = publicoReauth;
