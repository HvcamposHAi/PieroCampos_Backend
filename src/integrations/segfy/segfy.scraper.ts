/**
 * Fallback via Playwright: loga na SPA do Segfy e captura o token de autenticação
 * (interceptando o header Authorization das chamadas XHR). Serve como:
 *   - fonte de token quando o login REST não estiver confirmado, e
 *   - base para operações via UI quando a API não as expuser.
 *
 * ⚠️ GATE: os seletores de login e o fluxo de operações via UI dependem do
 * mapeamento (a SPA usa S3/CloudFront + New Relic/jam.dev → risco anti-bot).
 * Mantemos seletores tolerantes; confirme/ajuste após `npm run segfy:mapear`.
 *
 * ⚠️ 2FA (a partir de 01/06/2026): o login na SPA passa a exigir código por
 * e-mail. O fluxo abaixo (preencher email+senha → esperar /dashboard) vai
 * parar no desafio de 2FA. Tratar 2FA aqui (ler código do inbox) é frágil e
 * risco de ToS — preferir API oficial / usuário isento.
 */
import { chromium, type Browser, type Page } from "playwright";
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import { definirTokenManual } from "./segfy.auth";

let browser: Browser | null = null;
let page: Page | null = null;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export async function iniciarSessaoSegfy(): Promise<Page> {
  if (page) return page;
  const env = getEnv();

  browser = await chromium.launch({ headless: env.SEGFY_HEADLESS });
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const novaPagina = await context.newPage();

  // Captura o token a partir de qualquer requisição autenticada.
  novaPagina.on("request", (req) => {
    const auth = req.headers()["authorization"];
    if (auth?.toLowerCase().startsWith("bearer ")) {
      definirTokenManual(auth.slice("bearer ".length).trim());
    }
  });

  await novaPagina.goto(`${env.SEGFY_APP_URL.replace(/\/+$/, "")}/login`, {
    waitUntil: "networkidle",
  });

  await novaPagina.fill('input[name="email"], input[type="email"]', env.SEGFY_LOGIN);
  await novaPagina.fill('input[name="password"], input[type="password"]', env.SEGFY_SENHA);
  await novaPagina.click('button[type="submit"]');
  await novaPagina.waitForURL("**/dashboard**", { timeout: 15_000 });

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
