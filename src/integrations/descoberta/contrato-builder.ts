/**
 * Compõe a `PaginaContrato` (API-Doc) a partir das saídas de inferência. PURA:
 * combina endpoints + segurança + catálogo de ramos + premissas + OpenAPI. As
 * premissas-base são DETERMINÍSTICAS (derivadas do tráfego); o `premissas.llm`
 * pode AUMENTÁ-las depois. Status inicial sempre 'rascunho' (aprovação humana).
 */
import type { ContratoInferido } from "./inferencia/har-para-contrato";
import { inferirContrato } from "./inferencia/har-para-contrato";
import { analisarSeguranca, type SinaisDom } from "./inferencia/seguranca.probe";
import { detectarRamos } from "./inferencia/catalogo-ramos";
import { montarOpenApi } from "./inferencia/openapi";
import type { AnaliseSeguranca, HarResumo, Operacao, PaginaContrato, Premissa } from "./descoberta.types";

/** Premissas determinísticas derivadas do tráfego + segurança. */
export function derivarPremissasBase(contrato: ContratoInferido, seg: AnaliseSeguranca): Premissa[] {
  const premissas: Premissa[] = [];
  // login+senha SEMPRE obrigatório (premissa nº 0)
  premissas.push({ chave: "login_senha_obrigatorio", valor: true, evidencia: `auth=${seg.auth.esquema}`, confianca: 1 });

  const temCampoObrig = (nome: RegExp): { tem: boolean; conf: number } => {
    let tem = false;
    let conf = 0;
    for (const ep of contrato.endpoints) {
      const c = ep.campos.find((x) => nome.test(x.nome) && x.obrigatorio);
      if (c) {
        tem = true;
        conf = Math.max(conf, c.confianca);
      }
    }
    return { tem, conf };
  };
  const cpf = temCampoObrig(/cpf/i);
  if (cpf.tem) premissas.push({ chave: "cpf_obrigatorio", valor: true, evidencia: "campo cpf obrigatório", confianca: cpf.conf });
  const placa = temCampoObrig(/placa/i);
  if (placa.tem) premissas.push({ chave: "placa_obrigatoria", valor: true, confianca: placa.conf });
  const cep = temCampoObrig(/cep/i);
  if (cep.tem) premissas.push({ chave: "cep_obrigatorio", valor: true, confianca: cep.conf });

  if (seg.twoFactor.presente) premissas.push({ chave: "2fa_required", valor: true, evidencia: seg.twoFactor.metodo ?? "detectado", confianca: 0.9 });
  if (seg.captcha.presente) premissas.push({ chave: "captcha_presente", valor: seg.captcha.tipo ?? true, evidencia: seg.captcha.onde, confianca: 0.9 });
  if (!seg.transporte.tlsTudo) premissas.push({ chave: "http_puro_detectado", valor: true, evidencia: seg.transporte.httpPuroEm.join(","), confianca: 1 });
  if (seg.interceptacaoLimitada) premissas.push({ chave: "interceptacao_limitada", valor: true, evidencia: "payload cifrado/pinning", confianca: 0.8 });
  return premissas;
}

export interface MontarContratoInput {
  corretoraId: string;
  sistema: string;
  ramo: string;
  operacao?: Operacao;
  har: HarResumo;
  dom?: SinaisDom;
  ramosSuportados?: string[];
  /** convergência entre capturas redundantes. */
  estabilidade?: "estavel" | "instavel";
  /** premissas extras (ex.: vindas do LLM) a mesclar com as base. */
  premissasExtras?: Premissa[];
}

export function montarContrato(input: MontarContratoInput): PaginaContrato {
  const { corretoraId, sistema, ramo, operacao = "cotacao", har, dom, ramosSuportados, estabilidade, premissasExtras = [] } = input;
  const contrato = inferirContrato(har);
  const seguranca = analisarSeguranca(har, dom);
  const ramosDisponiveis = detectarRamos({ har, ramosSuportados, operacao });
  const premissasBase = derivarPremissasBase(contrato, seguranca);

  // mescla premissas (extras do LLM vencem na mesma chave)
  const mapa = new Map<string, Premissa>();
  for (const p of premissasBase) mapa.set(p.chave, p);
  for (const p of premissasExtras) mapa.set(p.chave, p);
  const premissas = [...mapa.values()];

  const openapi = montarOpenApi({ sistema, ramo, urlBase: contrato.urlBase, endpoints: contrato.endpoints, seguranca, premissas });

  return {
    corretoraId,
    sistema,
    ramo,
    operacao,
    urlBase: contrato.urlBase,
    versao: 1,
    openapi,
    premissas,
    ramosDisponiveis,
    seguranca,
    fluxo: contrato.fluxo,
    status: "rascunho",
    estabilidade: estabilidade ?? "estavel",
  };
}
