/**
 * Orquestra a INGESTÃO de uma descoberta: recebe o HAR resumido (do daemon ou
 * direto no Admin), monta a `PaginaContrato` (API-Doc), aumenta premissas via
 * LLM (best-effort), gera o `AdapterSpec` (rascunho) e persiste tudo como uma
 * nova VERSÃO. NÃO ativa nada (aprovação humana depois). Tudo injetável p/ teste.
 */
import { montarContrato } from "./contrato-builder";
import { inferirContrato } from "./inferencia/har-para-contrato";
import { analisarSeguranca, type SinaisDom } from "./inferencia/seguranca.probe";
import { inferirPremissasLLM } from "./inferencia/premissas.llm";
import { gerarAdapter } from "./gerador/adapter-gen";
import { salvarAdapter as salvarAdapterDb, salvarContrato as salvarContratoDb, type PersistDeps } from "./descoberta.persistence";
import type { HarResumo, Operacao, PaginaContrato, Premissa } from "./descoberta.types";

export interface IngerirInput {
  corretoraId: string;
  sistema: string;
  ramo: string;
  operacao?: Operacao;
  har: HarResumo;
  dom?: SinaisDom;
  ramosSuportados?: string[];
  estabilidade?: "estavel" | "instavel";
  /** liga o aumento por LLM (default true; FAIL-SAFE se sem chave/erro). */
  usarLLM?: boolean;
}

export interface IngerirDeps extends PersistDeps {
  inferirPremissasLLM?: typeof inferirPremissasLLM;
  salvarContrato?: typeof salvarContratoDb;
  salvarAdapter?: typeof salvarAdapterDb;
}

export interface IngerirResultado {
  contratoId: string;
  adapterId: string;
  versao: number;
  contrato: PaginaContrato;
}

export async function ingerirDescoberta(input: IngerirInput, deps: IngerirDeps = {}): Promise<IngerirResultado> {
  const { corretoraId, sistema, ramo, operacao = "cotacao", har, dom, ramosSuportados, estabilidade, usarLLM = true } = input;

  // 1) premissas extras via LLM (best-effort; FAIL-SAFE → [])
  let premissasExtras: Premissa[] = [];
  if (usarLLM) {
    const fnLLM = deps.inferirPremissasLLM ?? inferirPremissasLLM;
    const contratoInferido = inferirContrato(har);
    const seg = analisarSeguranca(har, dom);
    premissasExtras = await fnLLM({ sistema, ramo, har, endpoints: contratoInferido.endpoints, seguranca: seg }).catch(() => []);
  }

  // 2) monta a API-Doc
  const contrato = montarContrato({ corretoraId, sistema, ramo, operacao, har, dom, ramosSuportados, estabilidade, premissasExtras });

  // 3) persiste o contrato (nova versão, rascunho)
  const salvarContrato = deps.salvarContrato ?? salvarContratoDb;
  const { contratoId, versao } = await salvarContrato({ ...contrato, versao: 1 }, deps);

  // 4) gera + persiste o adapter (rascunho, inativo)
  const spec = gerarAdapter({ contrato: inferirContrato(har), sistema, ramo, operacao, versao });
  const salvarAdapter = deps.salvarAdapter ?? salvarAdapterDb;
  const { adapterId } = await salvarAdapter(corretoraId, contratoId, spec, deps);

  return { contratoId, adapterId, versao, contrato: { ...contrato, id: contratoId, versao } };
}
