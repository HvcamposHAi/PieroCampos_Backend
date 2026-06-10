/**
 * Renderizador de GRÁFICOS do Copiloto. Gera um PNG a partir de HTML/SVG via
 * Playwright (Chromium) — SEM serviço externo (LGPD: os dados não saem da infra).
 *
 * Espelha o gate do módulo de apólice: o Chromium só sobe quando habilitado. Em
 * produção o Render fica com `APOLICE_RPA_ENABLED=false` (sem Chromium no servidor),
 * então `GESTOR_GRAFICO_ENABLED` deve seguir a mesma realidade. FAIL-SAFE: qualquer
 * problema retorna null e o serviço cai no resumo em TEXTO (nunca derruba a resposta).
 */
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";

export interface BarraGrafico {
  rotulo: string;
  valor: number;
}

export interface SpecGrafico {
  titulo: string;
  barras: BarraGrafico[];
  /** Sufixo opcional dos valores (ex.: "R$"). */
  prefixoValor?: string;
}

function escaparHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

/** Monta um HTML simples de barras horizontais (CSS puro, sem libs externas). */
export function montarHtmlGrafico(spec: SpecGrafico): string {
  const max = Math.max(1, ...spec.barras.map((b) => (Number.isFinite(b.valor) ? b.valor : 0)));
  const linhas = spec.barras
    .slice(0, 12)
    .map((b) => {
      const pct = Math.max(2, Math.round(((b.valor || 0) / max) * 100));
      const valorFmt = `${spec.prefixoValor ?? ""}${(b.valor || 0).toLocaleString("pt-BR")}`;
      return `<div class="row"><div class="lbl">${escaparHtml(b.rotulo)}</div><div class="barwrap"><div class="bar" style="width:${pct}%"></div></div><div class="val">${escaparHtml(valorFmt)}</div></div>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;font-family:Inter,Arial,sans-serif}
    body{margin:0;padding:24px;width:720px;background:#fff;color:#0f172a}
    h1{font-size:22px;margin:0 0 18px}
    .row{display:flex;align-items:center;gap:12px;margin:10px 0}
    .lbl{width:170px;font-size:14px;text-align:right;color:#334155}
    .barwrap{flex:1;background:#f1f5f9;border-radius:6px;height:24px;overflow:hidden}
    .bar{height:100%;background:#ef4444;border-radius:6px}
    .val{width:120px;font-size:13px;color:#0f172a;font-variant-numeric:tabular-nums}
  </style></head><body><h1>${escaparHtml(spec.titulo)}</h1>${linhas}</body></html>`;
}

/**
 * Renderiza o gráfico em PNG. Retorna null quando o recurso está desligado ou o
 * Chromium falha (fallback textual no serviço). Import dinâmico do Playwright para
 * NÃO carregar o módulo (nem exigir o binário) quando o recurso está off.
 */
export async function gerarGraficoPng(spec: SpecGrafico): Promise<Buffer | null> {
  if (!getEnv().GESTOR_GRAFICO_ENABLED) return null;
  if (!spec.barras || spec.barras.length === 0) return null;
  let browser: import("playwright").Browser | null = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: getEnv().APOLICE_HEADLESS });
    const page = await browser.newPage({ viewport: { width: 760, height: 480 }, deviceScaleFactor: 2 });
    await page.setContent(montarHtmlGrafico(spec), { waitUntil: "load" });
    const el = await page.$("body");
    const png = el ? await el.screenshot({ type: "png" }) : await page.screenshot({ type: "png" });
    return png as Buffer;
  } catch (e) {
    logger.warn("[gestor.grafico] render falhou; fallback textual", { erro: (e as Error).message });
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
