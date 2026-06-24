/**
 * LOOP CONSTRUTOR — o "executar até concluir". Dado um objetivo + caso de teste,
 * roda o adapter corrente, AVALIA o critério de sucesso e, em falha, REFINA o
 * adapter e repete — até atingir o critério ou estourar `maxIteracoes`
 * (→ `requer_humano`). Orquestração PURA: o `runner` (que de fato executa, no
 * daemon via Playwright) e o `refino` (que ajusta os passos / re-resolve seletor)
 * são INJETADOS, então o loop é unit-testável sem browser.
 */
import type { AdapterSpec, CasoTeste, CriterioSucesso } from "../descoberta.types";
import { avaliarCriterio, criterioPadrao, type AvaliacaoCriterio, type ResultadoObjetivo } from "../criterio/avaliar";

export type StatusBuild = "validado" | "requer_humano" | "falhou";

export interface IteracaoLog {
  n: number;
  avaliacao: AvaliacaoCriterio;
  refinou: boolean;
}

export interface ResultadoBuild {
  status: StatusBuild;
  iteracoes: number;
  spec: AdapterSpec;
  ultimoResultado: ResultadoObjetivo | null;
  historico: IteracaoLog[];
}

export interface BuilderDeps {
  /** executa o adapter contra o caso de teste e devolve o resultado normalizado. */
  runner: (spec: AdapterSpec, caso: CasoTeste) => Promise<ResultadoObjetivo>;
  /** refina o adapter após uma falha (re-resolve seletor/ajusta passo). Retorna o
   *  novo spec, ou null se não há mais o que refinar (→ requer_humano). */
  refino?: (spec: AdapterSpec, avaliacao: AvaliacaoCriterio, resultado: ResultadoObjetivo) => Promise<AdapterSpec | null>;
  criterio?: CriterioSucesso;
  maxIteracoes?: number;
  log?: (msg: string) => void;
}

export async function construirAteObjetivo(specInicial: AdapterSpec, caso: CasoTeste, deps: BuilderDeps): Promise<ResultadoBuild> {
  const objetivo = specInicial.objetivo ?? specInicial.operacao;
  const criterio = deps.criterio ?? criterioPadrao(objetivo);
  const max = Math.max(1, deps.maxIteracoes ?? 5);
  const log = deps.log ?? ((): void => undefined);
  const historico: IteracaoLog[] = [];

  let spec = specInicial;
  let ultimoResultado: ResultadoObjetivo | null = null;

  for (let n = 1; n <= max; n++) {
    const resultado = await deps.runner(spec, caso);
    ultimoResultado = resultado;
    const avaliacao = avaliarCriterio(criterio, resultado);
    log(`iteração ${n}/${max}: ${avaliacao.atingido ? "OK" : "falhou"} — ${avaliacao.motivo}`);

    if (avaliacao.atingido) {
      historico.push({ n, avaliacao, refinou: false });
      return { status: "validado", iteracoes: n, spec, ultimoResultado, historico };
    }

    // falhou: tenta refinar p/ a próxima iteração
    const proximo = deps.refino ? await deps.refino(spec, avaliacao, resultado) : null;
    historico.push({ n, avaliacao, refinou: Boolean(proximo) });
    if (!proximo) {
      // sem refino possível → escala p/ humano (não insiste à toa)
      return { status: "requer_humano", iteracoes: n, spec, ultimoResultado, historico };
    }
    spec = proximo;
  }

  return { status: "requer_humano", iteracoes: max, spec, ultimoResultado, historico };
}
