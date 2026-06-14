/**
 * GERAÇÃO: contrato inferido → `AdapterSpec` DECLARATIVO (rascunho).
 *
 * Best-effort determinístico: mapeia o PAPEL de cada endpoint para um passo do
 * runner (auth→PassoAuth, criar/calcular→PassoHttp, poll→PassoPoll, resultado→
 * PassoExtract). O resultado é um RASCUNHO para revisão humana (nunca ativa
 * sozinho). Campos obrigatórios viram `entradaObrigatoria`. Sem código gerado.
 */
import type { ContratoInferido } from "../inferencia/har-para-contrato";
import type {
  AdapterSpec,
  CampoDescoberto,
  EndpointDescoberto,
  Operacao,
  PassoAdapter,
  PassoAuth,
  PassoExtract,
  PassoHttp,
  PassoPoll,
} from "../descoberta.types";

export interface GerarAdapterInput {
  contrato: ContratoInferido;
  sistema: string;
  ramo: string;
  operacao?: Operacao;
  versao?: number;
}

/** Heurística: caminho até o token na resposta do endpoint de auth. */
function tokenPathDe(ep: EndpointDescoberto): string {
  const chaves = ep.respostaChaves.map((c) => c.toLowerCase());
  if (chaves.includes("data")) return "data.token";
  if (chaves.includes("token")) return "token";
  if (chaves.includes("access_token")) return "access_token";
  return "token";
}

function urlDe(ep: EndpointDescoberto): string {
  return `${ep.urlBase}${ep.pathTemplate}`;
}

/** Monta corpo-template a partir dos campos: { cpf: "{{cpf}}", ... } */
function corpoTemplate(campos: CampoDescoberto[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of campos) out[c.nome] = `{{${c.nome}}}`;
  return out;
}

const HEADER_BEARER: Record<string, string> = { Authorization: "Bearer {{token}}" };

export function gerarAdapter(input: GerarAdapterInput): AdapterSpec {
  const { contrato, sistema, ramo, operacao = "cotacao", versao = 1 } = input;
  const passos: PassoAdapter[] = [];
  const obrig = new Set<string>();

  const auth = contrato.endpoints.find((e) => e.papel === "auth");
  if (auth) {
    const p: PassoAuth = {
      tipo: "auth",
      metodo: "http_login",
      url: urlDe(auth),
      corpo: corpoTemplate(auth.campos),
      tokenPath: tokenPathDe(auth),
      guardarEm: "token",
    };
    passos.push(p);
    auth.campos.filter((c) => c.obrigatorio).forEach((c) => obrig.add(c.nome));
  }

  for (const ep of contrato.endpoints.filter((e) => e.papel === "criar" || e.papel === "calcular")) {
    const p: PassoHttp = {
      tipo: "http",
      metodo: ep.metodo === "GET" ? "GET" : (ep.metodo as PassoHttp["metodo"]),
      url: urlDe(ep),
      headers: ep.auth === "bearer" ? { ...HEADER_BEARER } : undefined,
      corpo: ep.metodo === "GET" ? undefined : corpoTemplate(ep.campos),
      extrair: ep.respostaChaves.includes("id") ? { idIntegracao: "id" } : undefined,
    };
    passos.push(p);
    ep.campos.filter((c) => c.obrigatorio).forEach((c) => obrig.add(c.nome));
  }

  const poll = contrato.endpoints.find((e) => e.papel === "poll");
  if (poll) {
    const p: PassoPoll = {
      tipo: "poll",
      metodo: "GET",
      url: urlDe(poll),
      headers: poll.auth === "bearer" ? { ...HEADER_BEARER } : undefined,
      intervaloMs: 6_000,
      timeoutMs: 90_000,
      prontoQuando: { caminho: "retorno", igualA: true },
    };
    passos.push(p);
  }

  const resultado = contrato.endpoints.find((e) => e.papel === "resultado") ?? poll;
  if (resultado) {
    const chaves = resultado.respostaChaves.map((c) => c.toLowerCase());
    const arrayEm = chaves.includes("resultados") ? "resultados" : chaves.includes("data") ? "data" : "resultados";
    const p: PassoExtract = {
      tipo: "extract",
      arrayEm,
      mapa: {
        seguradora: "seguradora",
        premio_total: "premio",
        parcelas: "parcelas",
        valor_parcela: "valorParcela",
        coberturas_resumo: "coberturas",
        status: "status",
      },
    };
    passos.push(p);
  }

  return {
    sistema,
    ramo,
    operacao,
    versao,
    entradaObrigatoria: [...obrig],
    passos,
    resiliencia: { maxRetries: 3, backoffBaseMs: 500, timeoutMsPadrao: 30_000 },
  };
}
