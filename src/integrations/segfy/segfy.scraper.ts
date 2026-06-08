/**
 * Playwright para o Segfy — duas finalidades:
 *
 *  1) REAUTENTICAÇÃO ASSISTIDA (2FA, a partir de 01/06/2026): o operador dispara
 *     pelo Admin; abrimos o navegador, logamos, PARAMOS no desafio de 2FA, o
 *     operador digita o código (recebido por e-mail), preenchemos, marcamos
 *     "lembrar 30 dias" e capturamos o `storageState` (cookies de DEVICE TRUST) +
 *     os tokens de automação da resposta de /auth/login. A camada de serviço
 *     (segfy-sessao.service) cifra e persiste — este módulo NÃO conhece Supabase.
 *
 *  2) Sessão legada (iniciarSessaoSegfy) — captura de bearer por interceptação,
 *     mantida para o orquestrador antigo (segfy.client.ts). Não usada no caminho
 *     atual de cotação.
 *
 * Seletores tolerantes (a SPA muda layout). Nunca logamos email/senha/código/token.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import { buscarOTPSegfy } from "../gmail/otp.gmail";
import { definirTokenManual } from "./segfy.auth";

let browser: Browser | null = null;
let page: Page | null = null;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** URL do login (onde o desafio de 2FA acontece) — confirmada no tráfego real. */
const LOGIN_URL = "https://login.segfy.com/login";
/** Campos típicos do desafio de 2FA por e-mail (seletores tolerantes). */
const SELETOR_OTP =
  'input[name="code"], input[name="otp"], input[name="token"], input[autocomplete="one-time-code"], input[inputmode="numeric"]';
// A tela do Segfy usa <input> "pelado" (sem name/type) p/ o e-mail; por isso
// incluímos input[type="text"] e input:not([type]) como fallback tolerante.
const SELETOR_EMAIL =
  'input[name="email"], input[type="email"], input[type="text"], input:not([type])';
const SELETOR_SENHA = 'input[name="password"], input[type="password"]';
const SELETOR_SUBMIT = 'button[type="submit"]';
// Banner de cookies do HubSpot que intercepta o clique no "Entrar".
const SELETOR_COOKIES_OK = "#hs-eu-confirmation-button, #hs-eu-cookie-confirmation button";
const TIMEOUT_2FA_MS = 12_000;
const TIMEOUT_LOGADO_MS = 30_000;

/**
 * Mensagem do gate. Sinaliza à camada de serviço/rotas que o scraping (Playwright)
 * está desligado (SEGFY_SCRAPING_ENABLED=false) — distinto de um erro de login.
 */
const ERRO_SCRAPING_OFF = "scraping_desabilitado";

/** Gate PRIMÁRIO do navegador: barra QUALQUER caminho de subir Chromium quando a
 *  flag está off. Centralizado aqui (antes de chromium.launch) para que nenhum
 *  caller consiga iniciar o Playwright independentemente de quem chame. */
function assegurarScrapingHabilitado(): void {
  if (!getEnv().SEGFY_SCRAPING_ENABLED) throw new Error(ERRO_SCRAPING_OFF);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Reautenticação assistida (2FA)
// ─────────────────────────────────────────────────────────────────────────────

export interface TokensCapturados {
  authAutomationToken: string;
  userAutomationToken: string;
}

/** Estado em memória do fluxo entre "iniciar" e "confirmar" (segurado pela service). */
export interface ReauthHandle {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Tokens lidos da resposta de /auth/login (null até o login concluir). */
  lerTokens(): TokensCapturados | null;
}

export interface ResultadoReauth {
  /** Saída de context.storageState() — cookies (device trust) + localStorage. */
  storageState: unknown;
  tokens: TokensCapturados | null;
}

/** Instala a interceptação que lê os tokens de automação da resposta de /auth/login. */
function instalarCapturaDeTokens(p: Page): () => TokensCapturados | null {
  let capturados: TokensCapturados | null = null;
  p.on("response", (resp) => {
    if (!resp.url().includes("/auth/login")) return;
    void resp
      .json()
      .then((body: unknown) => {
        const d = (body as { data?: Partial<TokensCapturados> } | undefined)?.data;
        if (d?.authAutomationToken && d?.userAutomationToken) {
          capturados = { authAutomationToken: d.authAutomationToken, userAutomationToken: d.userAutomationToken };
          logger.info("Segfy reauth: tokens de automação capturados"); // nunca logamos o valor
        }
      })
      .catch(() => {
        /* resposta não-JSON (ex.: challenge) — ignora */
      });
  });
  return () => capturados;
}

/** Marca o "lembrar dispositivo (30 dias)" se o checkbox existir (no-op tolerante). */
async function marcarLembrarDispositivo(p: Page): Promise<void> {
  try {
    const chk = p.locator('input[type="checkbox"]').first();
    if (await chk.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await chk.check({ timeout: 2_000 }).catch(() => undefined);
    }
  } catch {
    /* sem checkbox — segue */
  }
}

/** Considera "logado" quando saiu da tela de login (callback p/ app/gestao). */
async function esperarLogado(p: Page): Promise<void> {
  await p.waitForURL((u) => !u.toString().includes("login.segfy.com"), { timeout: TIMEOUT_LOGADO_MS });
}

/** Dispensa o banner de cookies do HubSpot (intercepta o clique no submit). No-op tolerante. */
async function dispensarBannerCookies(p: Page): Promise<void> {
  try {
    const ok = p.locator(SELETOR_COOKIES_OK).first();
    if (await ok.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await ok.click({ timeout: 2_000 }).catch(() => undefined);
    }
  } catch {
    /* sem banner — segue */
  }
}

/** Submete o formulário; se o clique no botão for interceptado, cai p/ Enter na senha. */
async function submeter(p: Page): Promise<void> {
  await p
    .locator(SELETOR_SUBMIT)
    .first()
    .click({ timeout: 8_000 })
    .catch(async () => {
      await p.locator(SELETOR_SENHA).first().press("Enter").catch(() => undefined);
    });
}

/**
 * Passo 1 da reauth: loga e PARA no 2FA. Se o dispositivo já for confiável (sem
 * desafio), conclui de imediato e devolve o resultado. `storageState` opcional
 * tenta reaproveitar uma sessão anterior para PULAR o 2FA.
 */
export async function iniciarReauthSegfy(opts: {
  email: string;
  password: string;
  headless: boolean;
  storageState?: unknown;
}): Promise<{ handle: ReauthHandle; estado: "aguardando_codigo" | "concluido"; resultado?: ResultadoReauth }> {
  assegurarScrapingHabilitado();
  const b = await chromium.launch({ headless: opts.headless });
  const context = await b.newContext({
    userAgent: USER_AGENT,
    ...(opts.storageState ? { storageState: opts.storageState as never } : {}),
  });
  const p = await context.newPage();
  const lerTokens = instalarCapturaDeTokens(p);
  const handle: ReauthHandle = { browser: b, context, page: p, lerTokens };

  try {
    await p.goto(LOGIN_URL, { waitUntil: "networkidle" });
    await p.locator(SELETOR_EMAIL).first().fill(opts.email);
    await p.locator(SELETOR_SENHA).first().fill(opts.password);
    await dispensarBannerCookies(p);
    await submeter(p);

    // Corrida: desafio de 2FA aparece OU já entramos (device confiável/isento).
    const apareceuOtp = await p
      .locator(SELETOR_OTP)
      .first()
      .waitFor({ state: "visible", timeout: TIMEOUT_2FA_MS })
      .then(() => true)
      .catch(() => false);

    if (apareceuOtp) {
      logger.info("Segfy reauth: desafio de 2FA exibido — aguardando código do operador");
      return { handle, estado: "aguardando_codigo" };
    }

    // Sem 2FA: confirma que logou e captura a sessão.
    await esperarLogado(p);
    const resultado = await finalizarCaptura(handle);
    return { handle, estado: "concluido", resultado };
  } catch (e) {
    await abortarReauthSegfy(handle);
    throw e;
  }
}

/**
 * Passo 2 da reauth: preenche o código 2FA, marca "lembrar 30 dias", conclui o
 * login e captura a sessão confiável + tokens. Fecha o navegador no fim.
 */
export async function confirmarReauthSegfy(handle: ReauthHandle, codigo: string): Promise<ResultadoReauth> {
  const p = handle.page;
  try {
    const campo = p.locator(SELETOR_OTP).first();
    await campo.fill(codigo);
    await marcarLembrarDispositivo(p);
    await dispensarBannerCookies(p);
    await submeter(p);
    await esperarLogado(p);
    return await finalizarCaptura(handle);
  } finally {
    await fechar(handle).catch(() => undefined);
  }
}

/** Lê storageState + tokens; dá uma folga para as XHRs pós-login dispararem. */
async function finalizarCaptura(handle: ReauthHandle): Promise<ResultadoReauth> {
  // /auth/login pode resolver logo após o redirect — pequena espera tolerante.
  for (let i = 0; i < 6 && !handle.lerTokens(); i++) {
    await handle.page.waitForTimeout(500);
  }
  const storageState = await handle.context.storageState();
  return { storageState, tokens: handle.lerTokens() };
}

async function fechar(handle: ReauthHandle): Promise<void> {
  await handle.context.close().catch(() => undefined);
  await handle.browser.close().catch(() => undefined);
}

/** Aborta o fluxo (timeout/erro/cancelamento) liberando o navegador. */
export async function abortarReauthSegfy(handle: ReauthHandle): Promise<void> {
  await fechar(handle);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Sessão legada (orquestrador antigo) — mantida p/ retrocompatibilidade
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Se a SPA exibir o desafio de 2FA, captura o código por e-mail (Gmail) e
 * preenche. Sem 2FA (ex.: usuário isento) é no-op rápido.
 */
async function tratar2FASePreciso(p: Page): Promise<void> {
  const campoOtp = p.locator(SELETOR_OTP).first();
  const apareceu = await campoOtp
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!apareceu) return;

  logger.warn("Segfy: desafio de 2FA detectado — buscando código via Gmail");
  const codigo = await buscarOTPSegfy(); // nunca logado
  await campoOtp.fill(codigo);
  await p.click(SELETOR_SUBMIT);
}

export async function iniciarSessaoSegfy(): Promise<Page> {
  if (page) return page;
  assegurarScrapingHabilitado();
  const env = getEnv();

  browser = await chromium.launch({ headless: env.SEGFY_HEADLESS });
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const novaPagina = await context.newPage();

  novaPagina.on("request", (req) => {
    const auth = req.headers()["authorization"];
    if (auth?.toLowerCase().startsWith("bearer ")) {
      definirTokenManual(auth.slice("bearer ".length).trim());
    }
  });

  await novaPagina.goto(`${env.SEGFY_APP_URL.replace(/\/+$/, "")}/login`, { waitUntil: "networkidle" });
  await novaPagina.fill(SELETOR_EMAIL, env.SEGFY_LOGIN);
  await novaPagina.fill(SELETOR_SENHA, env.SEGFY_SENHA);
  await novaPagina.click(SELETOR_SUBMIT);

  await tratar2FASePreciso(novaPagina);
  await novaPagina.waitForURL("**/dashboard**", { timeout: 20_000 });

  logger.info("Segfy: sessão (scraper) iniciada");
  page = novaPagina;
  return page;
}

export async function encerrarSessaoSegfy(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
  }
}
