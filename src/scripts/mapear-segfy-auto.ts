/**
 * Mapeamento AUTOMATIZADO e READ-ONLY do Segfy.
 *
 * Faz UMA tentativa de login com as credenciais do .env e captura todo o
 * tráfego XHR/Fetch que a SPA dispara (inclui o POST de login e os GETs que o
 * dashboard carrega sozinho). NÃO cria segurado nem cotação — não gera dado na
 * produção da Segfy. Objetivo: descobrir base URL real, endpoint/contrato de
 * auth e shapes de leitura.
 *
 * Saída: src/integrations/segfy/endpoints-mapeados.json (gitignored).
 * Headers sensíveis são redigidos; corpos de resposta são amostrados.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { getEnv } from "../config/env";
import { logger, redigir } from "../utils/logger";

interface ChamadaMapeada {
  method: string;
  url: string;
  host: string;
  resourceType: string;
  requestHeaders: unknown;
  requestBody?: string;
  status?: number;
  contentType?: string;
  responseSample?: string;
}

const SAIDA = resolve(__dirname, "../integrations/segfy/endpoints-mapeados.json");
const MAX_AMOSTRA = 4_000;

async function lancarNavegador(): Promise<{ browser: Browser; headless: boolean }> {
  try {
    return { browser: await chromium.launch({ headless: false }), headless: false };
  } catch (e) {
    logger.warn("Falha ao abrir navegador headful — tentando headless", {
      mensagem: e instanceof Error ? e.message : String(e),
    });
    return { browser: await chromium.launch({ headless: true }), headless: true };
  }
}

async function main(): Promise<void> {
  const env = getEnv();
  if (!env.SEGFY_LOGIN || !env.SEGFY_SENHA) {
    logger.error("SEGFY_LOGIN/SEGFY_SENHA ausentes no .env — preencha antes de mapear.");
    process.exit(1);
  }

  const chamadas: ChamadaMapeada[] = [];
  let tokenCapturado = false;

  const { browser, headless } = await lancarNavegador();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  const page = await context.newPage();

  page.on("request", (req) => {
    const tipo = req.resourceType();
    if (tipo !== "xhr" && tipo !== "fetch") return;
    const auth = req.headers()["authorization"];
    if (auth?.toLowerCase().startsWith("bearer ")) tokenCapturado = true;
    let host = "";
    try {
      host = new URL(req.url()).host;
    } catch {
      /* ignore */
    }
    chamadas.push({
      method: req.method(),
      url: req.url(),
      host,
      resourceType: tipo,
      requestHeaders: redigir(req.headers()),
      requestBody: req.postData() ?? undefined,
    });
  });

  page.on("response", async (resp) => {
    const tipo = resp.request().resourceType();
    if (tipo !== "xhr" && tipo !== "fetch") return;
    const reg = chamadas.find((c) => c.url === resp.url() && c.status === undefined);
    if (!reg) return;
    reg.status = resp.status();
    reg.contentType = resp.headers()["content-type"];
    try {
      reg.responseSample = (await resp.text()).slice(0, MAX_AMOSTRA);
    } catch {
      /* corpos binários/streamed ignorados */
    }
  });

  const loginUrl = `${env.SEGFY_APP_URL.replace(/\/+$/, "")}/login`;
  logger.info("Abrindo SPA", { loginUrl, headless });
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Após o app.segfy.com redirecionar para o SSO (login.segfy.com), espera o
  // form renderizar antes de preencher.
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);

  // UMA tentativa de login — seletores tolerantes; falhas individuais não abortam.
  const tentar = async (fn: () => Promise<void>, oque: string) => {
    try {
      await fn();
    } catch {
      logger.warn(`mapeamento: não consegui ${oque} (seletor pode diferir)`);
    }
  };
  // Email = primeiro input não-senha em ordem de DOM. O form do SSO (login.segfy.com)
  // usa um <input> SEM type/name/id, então casamos por exclusão da senha.
  const emailInput = page.locator("input:not([type=password])").first();
  const senhaInput = page.locator('input[type="password"]').first();
  const btnEntrar = page
    .getByRole("button", { name: /entrar|acessar|login/i })
    .or(page.locator('button[type="submit"]'))
    .first();

  await tentar(async () => {
    await emailInput.waitFor({ state: "visible", timeout: 20_000 });
    await emailInput.fill(env.SEGFY_LOGIN);
  }, "preencher e-mail");
  await tentar(() => senhaInput.fill(env.SEGFY_SENHA, { timeout: 10_000 }), "preencher senha");
  // Submeter: Enter na senha é mais confiável que clicar (o botão pode estar
  // coberto pelo widget de chat/reCAPTCHA invisível). Click forçado como fallback.
  await tentar(async () => {
    await senhaInput.press("Enter");
    await page.waitForURL((u) => !u.href.includes("login.segfy.com"), { timeout: 12_000 });
  }, "submeter via Enter");
  if (page.url().includes("login.segfy.com")) {
    await tentar(() => btnEntrar.click({ timeout: 8_000, force: true }), "clicar em entrar (fallback)");
  }

  // Deixa o tráfego pós-login assentar (sem repetir login).
  await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => undefined);
  await page.waitForTimeout(6_000);

  const hosts = [...new Set(chamadas.map((c) => c.host).filter(Boolean))];
  const resumo = {
    capturadoEm: new Date().toISOString(),
    tokenBearerObservado: tokenCapturado,
    totalChamadas: chamadas.length,
    hostsDeApi: hosts,
    urlFinal: page.url(),
    chamadas,
  };

  await writeFile(SAIDA, JSON.stringify(resumo, null, 2), "utf8");
  logger.info("Mapa salvo", {
    saida: SAIDA,
    totalChamadas: chamadas.length,
    hostsDeApi: hosts,
    tokenBearerObservado: tokenCapturado,
    urlFinal: page.url(),
  });

  await browser.close();
}

void main().catch((e) => {
  logger.error("Falha no mapeamento automático", {
    mensagem: e instanceof Error ? e.message : String(e),
  });
  process.exit(1);
});
