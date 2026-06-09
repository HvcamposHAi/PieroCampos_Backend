/**
 * Playwright da EMISSÃO de apólice por PORTAL de seguradora (grupos B_rpa/C_otp).
 * Espelha as práticas de segfy.scraper.ts:
 *   - GATE primário antes de chromium.launch (APOLICE_RPA_ENABLED);
 *   - seletores tolerantes (delegados ao driver do portal);
 *   - headless por env;
 *   - NUNCA loga usuário/senha/OTP/PDF — só o evento.
 *
 * Módulo ISOLADO: recebe credenciais e config como DADO; não conhece Supabase.
 * NUNCA lança por falha de portal — devolve EmitirApoliceResult.sucesso=false.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import type {
  CredenciaisPortal,
  EmitirApoliceContext,
  EmitirApoliceResult,
  SeguradoraConfigRef,
} from "./apolice-provider.port";
import { resolverDriver } from "./portais";
import type { PortalDriver, SeletoresLogin } from "./portais/driver.port";
import { preencherLoginPadrao } from "./portais/driver.port";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Sinaliza que o navegador está desligado (distinto de erro de login). */
export const ERRO_RPA_OFF = "apolice_rpa_desabilitado";
const TIMEOUT_LOGADO_MS = 30_000;
const TIMEOUT_OTP_MS = 12_000;

/** Gate PRIMÁRIO: barra qualquer subida de Chromium quando a flag está off. */
function assegurarApoliceRpaHabilitado(): void {
  if (!getEnv().APOLICE_RPA_ENABLED) throw new Error(ERRO_RPA_OFF);
}

async function dispensarBannerCookies(page: Page, seletor?: string): Promise<void> {
  if (!seletor) return;
  try {
    const ok = page.locator(seletor).first();
    if (await ok.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await ok.click({ timeout: 2_000 }).catch(() => undefined);
    }
  } catch {
    /* sem banner — segue */
  }
}

async function submeterLogin(page: Page, seletores: SeletoresLogin): Promise<void> {
  await page
    .locator(seletores.submit)
    .first()
    .click({ timeout: 8_000 })
    .catch(async () => {
      await page.locator(seletores.senha).first().press("Enter").catch(() => undefined);
    });
}

/** Preenche o desafio de OTP quando aparecer (grupo C_otp). No-op tolerante se não houver. */
async function tratarOtpSeNecessario(
  page: Page,
  seletores: SeletoresLogin,
  obterOtp?: () => Promise<string>,
): Promise<void> {
  if (!seletores.otp || !obterOtp) return;
  const campo = page.locator(seletores.otp).first();
  const apareceu = await campo
    .waitFor({ state: "visible", timeout: TIMEOUT_OTP_MS })
    .then(() => true)
    .catch(() => false);
  if (!apareceu) return;
  logger.info("[apolice.scraper] desafio de OTP detectado — buscando código"); // nunca loga o valor
  const codigo = await obterOtp();
  const boxes = page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"]');
  const n = await boxes.count().catch(() => 0);
  if (n >= codigo.length) {
    await boxes.first().click().catch(() => undefined);
    await page.keyboard.type(codigo, { delay: 60 });
  } else {
    await campo.fill(codigo).catch(() => undefined);
  }
  await submeterLogin(page, seletores);
}

/** Login comum: navega, preenche, dispensa cookies, submete e (se preciso) trata OTP. */
async function logar(
  page: Page,
  driver: PortalDriver,
  ctx: EmitirApoliceContext,
): Promise<void> {
  const url = driver.loginUrl ?? ctx.seguradora.urlPortal;
  if (!url) throw new Error("portal_sem_url");
  await page.goto(url, { waitUntil: "networkidle" });
  await preencherLoginPadrao(page, driver.seletores, ctx.credenciais);
  await dispensarBannerCookies(page, driver.seletores.cookiesOk);
  await submeterLogin(page, driver.seletores);
  await tratarOtpSeNecessario(page, driver.seletores, ctx.obterOtp);
}

async function fechar(browser: Browser | null, context: BrowserContext | null): Promise<void> {
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
}

/**
 * Emite a apólice no portal da seguradora. Resolve o driver por `nome_display`,
 * loga, localiza a proposta, emite, baixa o PDF e extrai os campos. Sempre fecha
 * o navegador. Devolve sucesso=false + erro em qualquer falha (não lança).
 */
export async function emitirApolicePortal(ctx: EmitirApoliceContext): Promise<EmitirApoliceResult> {
  const vazio: EmitirApoliceResult = {
    sucesso: false,
    numeroApolice: null,
    inicioVigencia: null,
    fimVigencia: null,
    premioTotal: null,
    premioLiquido: null,
    pdf: null,
  };
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  try {
    assegurarApoliceRpaHabilitado();
    const driver = resolverDriver(ctx.seguradora);
    browser = await chromium.launch({ headless: getEnv().APOLICE_HEADLESS });
    context = await browser.newContext({ userAgent: USER_AGENT, acceptDownloads: true });
    const page = await context.newPage();

    await logar(page, driver, ctx);
    await page.waitForURL((u) => !u.toString().includes("/login"), { timeout: TIMEOUT_LOGADO_MS }).catch(() => undefined);

    await driver.localizarProposta(page, ctx);
    const download = await driver.emitir(page, ctx);
    const dados = await driver.extrair(page, ctx);

    let pdf: { bytes: Buffer; contentType: string } | null = null;
    if (download) {
      const stream = await download.createReadStream().catch(() => null);
      if (stream) {
        const chunks: Buffer[] = [];
        for await (const c of stream) chunks.push(c as Buffer);
        pdf = { bytes: Buffer.concat(chunks), contentType: "application/pdf" };
      }
    }

    return { sucesso: !!dados.numeroApolice, ...dados, pdf };
  } catch (e) {
    const erro = (e as Error).message;
    if (erro !== ERRO_RPA_OFF) logger.warn("[apolice.scraper] emissão falhou", { erro });
    return { ...vazio, erro };
  } finally {
    await fechar(browser, context);
  }
}

/**
 * Teste de CONECTIVIDADE (botão "Testar") para portais B_rpa/C_otp: só faz o
 * login de verificação e confirma que saiu da tela de login. Não emite nada.
 */
export async function testarConexaoPortal(
  seg: SeguradoraConfigRef,
  cred: CredenciaisPortal,
  obterOtp?: () => Promise<string>,
): Promise<{ ok: boolean; mensagem: string }> {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  try {
    assegurarApoliceRpaHabilitado();
    const driver = resolverDriver(seg);
    browser = await chromium.launch({ headless: getEnv().APOLICE_HEADLESS });
    context = await browser.newContext({ userAgent: USER_AGENT });
    const page = await context.newPage();
    await logar(page, driver, { seguradora: seg, credenciais: cred, corretoraId: seg.corretoraId, proposta: { id: "", numeroProposta: null, clienteId: "", ramo: "", cotacaoId: null }, obterOtp });
    const logado = await page
      .waitForURL((u) => !u.toString().includes("/login"), { timeout: TIMEOUT_LOGADO_MS })
      .then(() => true)
      .catch(() => false);
    return logado
      ? { ok: true, mensagem: "Login OK" }
      : { ok: false, mensagem: "Login não concluiu (credencial/2FA?)" };
  } catch (e) {
    return { ok: false, mensagem: (e as Error).message };
  } finally {
    await fechar(browser, context);
  }
}
