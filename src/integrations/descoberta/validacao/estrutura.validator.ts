/**
 * VALIDADOR DE ESTRUTURA — o PORTÃO antes de construir (premissa fundamental do
 * usuário: validar a estrutura do site da seguradora ANTES do desenvolvimento).
 *
 * PURO: recebe um "snapshot" da página (markup + elementos detectados + endpoints
 * observados) e o objetivo, e diz se o portal SUPORTA aquele objetivo, listando
 * as LACUNAS. Bloqueia o loop construtor quando `nao_suporta`. Reusa os sinais
 * que a captura/`coletarCandidatos` já produz; o LLM (opcional) só refina.
 */
import type { Objetivo } from "../descoberta.types";

export interface SnapshotEstrutura {
  /** HTML concatenado (sem PII do usuário). */
  markup?: string;
  /** papéis de elemento detectados na página (ex.: 'login_usuario','botao_emitir'). */
  papeis?: string[];
  /** caminhos de endpoint observados no tráfego (ex.: '/calcular','/emitir'). */
  endpoints?: string[];
  /** o login foi alcançado/funcionou na captura. */
  loginOk?: boolean;
}

export type Veredito = "suporta" | "parcial" | "nao_suporta";

export interface ResultadoValidacao {
  veredito: Veredito;
  lacunas: string[];
  /** o que foi exigido para o objetivo (transparência). */
  exigidos: string[];
}

const RE_LOGIN = /type=["']?password["']?|name=["']?(senha|password|pwd)["']?/i;
const RE_EMITIR = /\b(emitir|gerar ap[oó]lice|emiss[aã]o)\b/i;
const RE_BUSCA = /\b(buscar|localizar|n[uú]mero (da )?proposta|consultar)\b/i;
const RE_CALC = /\b(calcular|cotar|simular|cota[cç][aã]o)\b/i;

/** Requisitos por objetivo: o que a página PRECISA ter para o objetivo ser viável. */
function requisitos(objetivo: Objetivo): { chave: string; testar: (s: SnapshotEstrutura) => boolean }[] {
  const temLogin = (s: SnapshotEstrutura): boolean =>
    Boolean(s.loginOk) || RE_LOGIN.test(s.markup ?? "") || (s.papeis ?? []).some((p) => /login|usuario|senha/i.test(p));
  const reqLogin = { chave: "login (usuário+senha)", testar: temLogin };

  switch (objetivo) {
    case "validar_estrutura":
      return [reqLogin];
    case "consulta":
      return [reqLogin, { chave: "campo de busca/consulta", testar: (s) => RE_BUSCA.test(s.markup ?? "") || (s.endpoints ?? []).some((e) => /consult|status|busca/i.test(e)) }];
    case "cotacao":
      return [
        reqLogin,
        { chave: "ação de calcular/cotar", testar: (s) => RE_CALC.test(s.markup ?? "") || (s.endpoints ?? []).some((e) => /calcul|cotac|quote|simul/i.test(e)) },
      ];
    case "apolice":
      return [
        reqLogin,
        { chave: "localizar proposta", testar: (s) => RE_BUSCA.test(s.markup ?? "") || (s.endpoints ?? []).some((e) => /proposta|busca|localiz/i.test(e)) },
        { chave: "ação de emitir apólice", testar: (s) => RE_EMITIR.test(s.markup ?? "") || (s.papeis ?? []).some((p) => /emitir|emiss/i.test(p)) || (s.endpoints ?? []).some((e) => /emitir|emiss|apolice/i.test(e)) },
      ];
  }
}

export function validarEstrutura(objetivo: Objetivo, snapshot: SnapshotEstrutura): ResultadoValidacao {
  const reqs = requisitos(objetivo);
  const exigidos = reqs.map((r) => r.chave);
  const lacunas = reqs.filter((r) => !r.testar(snapshot)).map((r) => r.chave);

  let veredito: Veredito;
  if (lacunas.length === 0) veredito = "suporta";
  // login é eliminatório: sem login, não há como operar
  else if (lacunas.includes("login (usuário+senha)")) veredito = "nao_suporta";
  else veredito = "parcial";

  return { veredito, lacunas, exigidos };
}
