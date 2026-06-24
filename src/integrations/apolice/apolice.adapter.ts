/**
 * EMISSÃO DE APÓLICE via ADAPTER do ADI (handoff do agente construtor → fluxo
 * convencional). Executa os passos DOM (`passosRpa`) de um AdapterSpec VALIDADO
 * para a seguradora e devolve `EmitirApoliceResult` (com o PDF). Reusa o
 * `rpa-runner` (whitelist, sem eval); a `PaginaRpa` é injetável (Playwright no
 * daemon; fake no teste). Gated por `APOLICE_RPA_ENABLED` como o scraper legado.
 *
 * NÃO toca storage/persistência: igual aos providers, devolve bytes do PDF e a
 * `apolice-emissao.service` cuida do upload/gravação.
 */
import { chromium, type Download, type Page } from "playwright";
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import type { AdapterSpec } from "../descoberta/descoberta.types";
import { executarRpa, type PaginaRpa, type RpaRunnerDeps } from "../descoberta/runtime/rpa-runner";
import type { ApoliceProvider, EmitirApoliceContext, EmitirApoliceResult } from "./apolice-provider.port";
import { resolverSeletor } from "./llm/portal-mapper.service";

const RESULTADO_VAZIO: EmitirApoliceResult = {
  sucesso: false,
  numeroApolice: null,
  inicioVigencia: null,
  fimVigencia: null,
  premioTotal: null,
  premioLiquido: null,
  pdf: null,
};

export interface AdapterApoliceDeps extends RpaRunnerDeps {
  /** cria a página (Playwright no daemon). Injetável p/ teste. */
  criarPagina?: (ctx: EmitirApoliceContext) => Promise<{ page: PaginaRpa; fechar: () => Promise<void> }>;
}

/** Monta o contexto de variáveis (template `{{...}}`) a partir do ctx de emissão. */
function montarContexto(ctx: EmitirApoliceContext): Record<string, unknown> {
  return {
    usuario: ctx.credenciais.usuario,
    senha: ctx.credenciais.senha,
    proposta: ctx.proposta.numeroProposta ?? "",
    propostaId: ctx.proposta.id,
    ...(ctx.credenciais.extra ?? {}),
  };
}

function numero(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Executa o adapter de emissão contra a página. `page` injetada nos testes;
 * em produção, `deps.criarPagina` sobe o Playwright (gated fora daqui).
 */
export async function emitirApoliceViaAdapter(
  ctx: EmitirApoliceContext,
  spec: AdapterSpec,
  page: PaginaRpa,
  deps: AdapterApoliceDeps = {},
): Promise<EmitirApoliceResult> {
  if (!spec.passosRpa || spec.passosRpa.length === 0) {
    return { ...RESULTADO_VAZIO, erro: "adapter_sem_passos_rpa" };
  }
  const contexto = montarContexto(ctx);
  const r = await executarRpa(spec.passosRpa, contexto, page, deps);
  if (!r.ok) {
    return { ...RESULTADO_VAZIO, erro: r.erro ?? "rpa_falhou", detalhe: r.passoFalho ? { passoFalho: r.passoFalho } : undefined };
  }
  const pdfBytes = page.ultimoPdf ? await page.ultimoPdf() : null;
  const numeroApolice = r.numeroApolice ?? null;
  return {
    sucesso: Boolean(numeroApolice),
    numeroApolice,
    inicioVigencia: typeof r.campos.inicioVigencia === "string" ? r.campos.inicioVigencia : null,
    fimVigencia: typeof r.campos.fimVigencia === "string" ? r.campos.fimVigencia : null,
    premioTotal: numero(r.campos.premioTotal),
    premioLiquido: numero(r.campos.premioLiquido),
    pdf: pdfBytes ? { bytes: pdfBytes, contentType: "application/pdf" } : null,
    erro: numeroApolice ? undefined : "numero_apolice_nao_extraido",
  };
}

// ── Wrapper Playwright → PaginaRpa (roda no daemon; gated APOLICE_RPA_ENABLED) ──

const RE_VALOR = /([A-Z]{1,4}[-\s]?\d[\w./-]{3,}|R\$\s?[\d.,]+|\d[\d.,]+)/i;

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

export interface PaginaBuild {
  page: PaginaRpa;
  fechar: () => Promise<void>;
  /** Page nativa do Playwright (p/ o portal-selector resolver papéis). */
  pageNativa?: Page;
}

/** Cria uma `PaginaRpa` sobre o Playwright. `fechar` encerra browser/context. */
async function criarPaginaPlaywright(): Promise<PaginaBuild> {
  const env = getEnv();
  const browser = await chromium.launch({ headless: env.APOLICE_HEADLESS });
  const ctx = await browser.newContext({
    acceptDownloads: true,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
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
        const [download] = await Promise.all([
          p.waitForEvent("download", { timeout: 30_000 }),
          p.click(sel, { timeout: 15_000 }),
        ]);
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
      // regex de rótulo "/.../i" → procura no innerText; senão é seletor CSS
      if (/^\/.*\/[a-z]*$/i.test(seletorOuRegex)) {
        const corpo = (await p.textContent("body").catch(() => "")) ?? "";
        const m = seletorOuRegex.match(/^\/(.*)\/([a-z]*)$/i);
        if (!m) return null;
        const re = new RegExp(m[1]!, m[2]);
        const linhas = corpo.split(/\n+/);
        const linha = linhas.find((l) => re.test(l));
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

/**
 * Provider de emissão por ADAPTER do ADI. Entra no fluxo convencional
 * (`emitirApolice`) no lugar do driver legado quando há adapter VALIDADO.
 * Gated por `APOLICE_RPA_ENABLED` (igual ao scraper): sobe o Playwright no daemon.
 * Reusa o portal-selector p/ resolver "papéis" em runtime.
 */
export function criarAdapterApoliceProvider(
  spec: AdapterSpec,
  criarPagina: () => Promise<PaginaBuild> = criarPaginaPlaywright,
): ApoliceProvider {
  return {
    nome: `apolice-adapter:${spec.seguradoraConfigId ?? spec.sistema}`,
    grupo: "B_rpa",
    async emitir(ctx: EmitirApoliceContext): Promise<EmitirApoliceResult> {
      if (!getEnv().APOLICE_RPA_ENABLED) {
        return { ...RESULTADO_VAZIO, erro: "apolice_rpa_desabilitado" };
      }
      let fechar: (() => Promise<void>) | null = null;
      try {
        const built = await criarPagina();
        fechar = built.fechar;
        const deps: AdapterApoliceDeps = {};
        const nativa = built.pageNativa;
        if (nativa) {
          deps.resolverSeletor = async (papel): Promise<string | null> =>
            resolverSeletor({
              seguradora: ctx.seguradora.nomeDisplay,
              acao: papel,
              descricaoAcao: `Elemento para a ação "${papel}" na emissão da apólice.`,
              corretoraId: ctx.corretoraId,
              page: nativa,
            });
        }
        return await emitirApoliceViaAdapter(ctx, spec, built.page, deps);
      } catch (e) {
        logger.warn("[apolice.adapter] emissão via adapter falhou", { erro: e instanceof Error ? e.message : String(e) });
        return { ...RESULTADO_VAZIO, erro: "adapter_excecao" };
      } finally {
        if (fechar) await fechar();
      }
    },
  };
}
