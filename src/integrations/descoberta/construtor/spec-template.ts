/**
 * Templates INICIAIS de AdapterSpec p/ o loop construtor partir (depois ele
 * refina). Usa seletores por PAPEL (resolvidos por LLM em runtime via
 * portal-selector) — assim o MESMO template vale p/ qualquer portal, e o agente
 * "autônomo nos passos" só precisa resolver os papéis. Reusa a forma que o
 * `generico.driver` já provou (login → localizar → emitir → extrair).
 *
 * SEGURANÇA (apólice emite de verdade): o passo de emitir é ÚNICO; o loop só deve
 * refinar os passos ANTES do emitir — nunca repetir o emitir (ver builder.loop +
 * daemon). PURO/testável.
 */
import type { AdapterSpec, Objetivo, PassoRpa } from "../descoberta.types";

export interface GerarSpecInicialInput {
  sistema: string;
  seguradoraConfigId: string;
  ramo: string;
  objetivo: Objetivo;
  urlPortal: string | null;
  versao?: number;
}

/** Passos genéricos de EMISSÃO de apólice (papel-based). */
function passosApolice(urlPortal: string | null): PassoRpa[] {
  const passos: PassoRpa[] = [];
  if (urlPortal) passos.push({ tipo: "navegar", url: urlPortal });
  passos.push(
    { tipo: "preencher", seletor: "login_usuario", papel: true, valor: "{{usuario}}", descricao: "campo de usuário/login" },
    { tipo: "preencher", seletor: "login_senha", papel: true, valor: "{{senha}}", descricao: "campo de senha" },
    { tipo: "clicar", seletor: "login_entrar", papel: true, descricao: "botão Entrar/Acessar" },
    { tipo: "esperar", sairDeUrl: "/login", timeoutMs: 30000 },
    { tipo: "preencher", seletor: "campo_busca_proposta", papel: true, valor: "{{proposta}}", descricao: "número da proposta a localizar" },
    { tipo: "clicar", seletor: "botao_buscar", papel: true, descricao: "botão buscar/localizar proposta" },
    { tipo: "esperar", ms: 1500 },
    // ÚNICO passo irreversível — o loop não deve repetir isto (ver builder/daemon)
    { tipo: "clicar", seletor: "botao_emitir", papel: true, descricao: "botão emitir apólice", esperarDownload: true },
    { tipo: "extrair_campo", nome: "numeroApolice", seletorOuRegex: "/ap[oó]lice|n[uú]mero/i" },
    { tipo: "extrair_campo", nome: "premioTotal", seletorOuRegex: "/pr[eê]mio total|total/i", comoMoeda: true },
    { tipo: "extrair_campo", nome: "premioLiquido", seletorOuRegex: "/pr[eê]mio l[ií]quido/i", comoMoeda: true },
    { tipo: "extrair_pdf", doDownload: true },
  );
  return passos;
}

/** Passos genéricos de CONSULTA (login → buscar → ler campo). */
function passosConsulta(urlPortal: string | null): PassoRpa[] {
  const passos: PassoRpa[] = [];
  if (urlPortal) passos.push({ tipo: "navegar", url: urlPortal });
  passos.push(
    { tipo: "preencher", seletor: "login_usuario", papel: true, valor: "{{usuario}}" },
    { tipo: "preencher", seletor: "login_senha", papel: true, valor: "{{senha}}" },
    { tipo: "clicar", seletor: "login_entrar", papel: true },
    { tipo: "esperar", sairDeUrl: "/login", timeoutMs: 30000 },
    { tipo: "preencher", seletor: "campo_consulta", papel: true, valor: "{{consulta}}" },
    { tipo: "clicar", seletor: "botao_consultar", papel: true },
    { tipo: "extrair_campo", nome: "resultado", seletorOuRegex: "/status|resultado/i" },
  );
  return passos;
}

/**
 * Gera o AdapterSpec INICIAL para o objetivo. Para `cotacao` (que costuma ter API
 * HTTP) o template RPA fica vazio — a cotação usa o pipeline HTTP (gerarAdapter).
 */
export function gerarSpecInicial(input: GerarSpecInicialInput): AdapterSpec {
  const { sistema, seguradoraConfigId, ramo, objetivo, urlPortal, versao = 1 } = input;
  let passosRpa: PassoRpa[] = [];
  let entrada: string[] = [];

  if (objetivo === "apolice") {
    passosRpa = passosApolice(urlPortal);
    entrada = ["usuario", "senha", "proposta"];
  } else if (objetivo === "consulta") {
    passosRpa = passosConsulta(urlPortal);
    entrada = ["usuario", "senha", "consulta"];
  } else if (objetivo === "validar_estrutura") {
    passosRpa = urlPortal ? [{ tipo: "navegar", url: urlPortal }] : [];
    entrada = [];
  }

  return {
    sistema,
    seguradoraConfigId,
    ramo,
    operacao: objetivo === "cotacao" ? "cotacao" : objetivo === "apolice" ? "apolice" : "consulta",
    objetivo,
    versao,
    entradaObrigatoria: entrada,
    passos: [],
    passosRpa,
    resiliencia: { maxRetries: 2, backoffBaseMs: 500, timeoutMsPadrao: 30000 },
  };
}
