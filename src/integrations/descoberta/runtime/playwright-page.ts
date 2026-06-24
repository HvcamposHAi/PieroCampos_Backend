/**
 * Wrapper Playwright → `PaginaRpa` (roda SÓ no daemon). Compartilhado entre a
 * emissão por adapter (apolice.adapter) e o loop construtor (daemon). `headless`
 * é parâmetro: emissão = headless; construção ASSISTIDA = visível (operador faz
 * login/2FA/captcha). Captura o PDF do download p/ `ultimoPdf()`.
 */
import { chromium, type Download, type Page } from "playwright";
import type { PaginaRpa } from "./rpa-runner";

export interface PaginaBuild {
  page: PaginaRpa;
  fechar: () => Promise<void>;
  /** Page nativa do Playwright (p/ o portal-selector resolver papéis). */
  pageNativa: Page;
}

const RE_VALOR = /([A-Z]{1,4}[-\s]?\d[\w./-]{3,}|R\$\s?[\d.,]+|\d[\d.,]+)/i;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function lerStream(download: Download): Promise<Buffer | null> {
  try {
    const stream = await download.createReadStream();
    if (!stream) return null;
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

export async function criarPaginaPlaywright(headless: boolean): Promise<PaginaBuild> {
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({ acceptDownloads: true, userAgent: USER_AGENT });
  const p: Page = await ctx.newPage();
  let pdf: Buffer | null = null;

  const page: PaginaRpa = {
    async navegar(url) {
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    },
    async preencher(sel, valor) {
      await p.fill(sel, valor, { timeout: 15_000 });
    },
    async clicar(sel, opts) {
      if (opts?.esperarDownload) {
        const [download] = await Promise.all([p.waitForEvent("download", { timeout: 30_000 }), p.click(sel, { timeout: 15_000 })]);
        pdf = await lerStream(download);
        return { downloadBytes: pdf?.length ?? 0 };
      }
      await p.click(sel, { timeout: 15_000 });
    },
    async esperarMs(ms) {
      await p.waitForTimeout(ms);
    },
    async esperarSeletor(sel, timeoutMs) {
      await p.waitForSelector(sel, { timeout: timeoutMs ?? 30_000 });
    },
    async esperarSairDeUrl(padrao, timeoutMs) {
      await p.waitForURL((u) => !u.toString().includes(padrao), { timeout: timeoutMs ?? 30_000 });
    },
    async extrair(seletorOuRegex) {
      if (/^\/.*\/[a-z]*$/i.test(seletorOuRegex)) {
        const corpo = (await p.textContent("body").catch(() => "")) ?? "";
        const m = seletorOuRegex.match(/^\/(.*)\/([a-z]*)$/i);
        if (!m) return null;
        const re = new RegExp(m[1]!, m[2]);
        const linha = corpo.split(/\n+/).find((l) => re.test(l));
        const v = linha?.match(RE_VALOR);
        return v?.[1] ?? linha?.trim() ?? null;
      }
      return (await p.textContent(seletorOuRegex).catch(() => null))?.trim() ?? null;
    },
    async ultimoPdf() {
      return pdf;
    },
  };

  return {
    page,
    pageNativa: p,
    fechar: async () => {
      await ctx.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}
