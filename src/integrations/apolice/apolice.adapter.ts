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
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import type { AdapterSpec } from "../descoberta/descoberta.types";
import { executarRpa, type PaginaRpa, type RpaRunnerDeps } from "../descoberta/runtime/rpa-runner";
import { criarPaginaPlaywright, type PaginaBuild } from "../descoberta/runtime/playwright-page";
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

/**
 * Provider de emissão por ADAPTER do ADI. Entra no fluxo convencional
 * (`emitirApolice`) no lugar do driver legado quando há adapter VALIDADO.
 * Gated por `APOLICE_RPA_ENABLED` (igual ao scraper): sobe o Playwright no daemon.
 * Reusa o portal-selector p/ resolver "papéis" em runtime.
 */
export function criarAdapterApoliceProvider(
  spec: AdapterSpec,
  criarPagina: () => Promise<PaginaBuild> = () => criarPaginaPlaywright(getEnv().APOLICE_HEADLESS),
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
