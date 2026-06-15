/**
 * CAPTURA tráfego-primeiro (CDP/HAR) — roda SÓ no daemon local (Playwright).
 *
 * Abre o portal, intercepta requests/responses HTTP/JSON via eventos do
 * Playwright (sem proxy externo), coleta links de menu do DOM e o markup p/ a
 * sondagem de segurança. REDIGE segredos/PII (Authorization/cookies/senha/cpf…)
 * ANTES de devolver — nada cru sai da máquina. `walkthrough` é injetado pelo
 * chamador (preenche os campos de teste e dispara a cotação) para gerar tráfego.
 *
 * Gated por DESCOBERTA_ENABLED + SEGFY_SCRAPING_ENABLED (mesmo navegador). Não é
 * importado pelo servidor (Render): só pelo script do agente local.
 */
import type { Browser, Page } from "playwright";
import { getEnv } from "../../../config/env";
import { logger } from "../../../utils/logger";
import { coletarPii, redigirCorpo, redigirHeaders } from "../descoberta.util";
import type { HarEntradaResumo, HarResumo } from "../descoberta.types";

const CONTENT_JSON = /application\/(json|.*\+json)/i;
const ESTATICO = /\.(js|css|png|jpe?g|svg|gif|woff2?|ico|map)(\?|$)/i;

function tentarJson(texto: string): unknown {
  try {
    return JSON.parse(texto);
  } catch {
    return undefined;
  }
}

export interface CapturaInput {
  url: string;
  /** preenche campos de teste e dispara a operação (gera tráfego). */
  walkthrough: (page: Page) => Promise<void>;
  /** sinaliza se o fluxo exigiu 2FA (humano no laço). */
  exigiu2fa?: boolean;
  timeoutMs?: number;
}

/**
 * Executa UMA captura. Recebe um Browser já aberto (o daemon controla o ciclo
 * de vida + login/2FA). Retorna o HAR resumido REDIGIDO + sinais de DOM.
 */
export async function capturarPagina(
  browser: Browser,
  input: CapturaInput,
): Promise<{ har: HarResumo; markup: string; piiTrafegada: string[] }> {
  if (!getEnv().DESCOBERTA_ENABLED) throw new Error("descoberta_desabilitada");
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  const page = await ctx.newPage();
  const entradas: HarEntradaResumo[] = [];
  const pii = new Set<string>();

  page.on("response", (resp) => {
    void (async () => {
      try {
        const req = resp.request();
        const url = req.url();
        if (ESTATICO.test(url)) return;
        const ct = (resp.headers()["content-type"] ?? "").toString();
        let respBody: unknown;
        if (CONTENT_JSON.test(ct)) {
          const txt = await resp.text().catch(() => "");
          respBody = txt ? tentarJson(txt) : undefined;
        }
        let reqBody: unknown;
        const postData = req.postData();
        if (postData) reqBody = tentarJson(postData) ?? "[BIN]";
        // coleta PII (nomes de chave) ANTES de redigir
        coletarPii(reqBody, pii);
        coletarPii(respBody, pii);
        entradas.push({
          metodo: req.method(),
          url,
          status: resp.status(),
          reqHeaders: redigirHeaders(req.headers()),
          reqBody: reqBody === undefined ? undefined : redigirCorpo(reqBody),
          respBody: respBody === undefined ? undefined : redigirCorpo(respBody),
          respHeaders: redigirHeaders(resp.headers()),
        });
      } catch (e) {
        logger.warn("[descoberta.captura] falha ao resumir resposta", { erro: (e as Error).message });
      }
    })();
  });

  await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: input.timeoutMs ?? 60_000 });
  await input.walkthrough(page);
  // dá um tempo para respostas assíncronas (polling) chegarem
  await page.waitForTimeout(2_000);

  // sinais de DOM: links de menu + markup (para captcha/2FA/auth)
  const domLinks = await page
    .$$eval("a[href]", (as) =>
      as.slice(0, 200).map((a) => {
        const el = a as unknown as { textContent: string | null; getAttribute(n: string): string | null };
        return { texto: (el.textContent ?? "").trim().slice(0, 60), href: el.getAttribute("href") ?? "" };
      }),
    )
    .catch(() => [] as { texto: string; href: string }[]);
  const markup = (await page.content().catch(() => "")).slice(0, 200_000);

  await ctx.close();
  return { har: { entradas, domLinks }, markup, piiTrafegada: [...pii] };
}

/**
 * Captura REDUNDANTE (≥2x) p/ convergência de shape (robustez): roda N vezes e
 * marca 'estavel' se os endpoints (método+path) coincidem entre as execuções.
 */
export async function capturarComConvergencia(
  browser: Browser,
  input: CapturaInput,
  vezes = 2,
): Promise<{ har: HarResumo; markup: string; estabilidade: "estavel" | "instavel"; piiTrafegada: string[] }> {
  const execs: { har: HarResumo; markup: string; piiTrafegada: string[] }[] = [];
  for (let i = 0; i < Math.max(1, vezes); i++) execs.push(await capturarPagina(browser, input));
  const assinatura = (h: HarResumo): string =>
    [...new Set(h.entradas.filter((e) => !ESTATICO.test(e.url)).map((e) => `${e.metodo} ${new URL(e.url).pathname.replace(/\d+/g, "#")}`))].sort().join("|");
  const base = assinatura(execs[0]!.har);
  const estavel = execs.every((e) => assinatura(e.har) === base);
  const piiUniao = new Set<string>();
  for (const e of execs) for (const p of e.piiTrafegada) piiUniao.add(p);
  return { har: execs[0]!.har, markup: execs[0]!.markup, estabilidade: estavel ? "estavel" : "instavel", piiTrafegada: [...piiUniao] };
}
