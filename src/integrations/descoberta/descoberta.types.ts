/**
 * Tipos do módulo DESCOBERTA (Agente Descobridor & Forja de Integrações — ADI).
 *
 * Generaliza o trabalho manual já feito à mão (Aggilizador via HAR, apólice via
 * portal drivers) num pipeline: CAPTURA → INFERÊNCIA → GERAÇÃO → EXECUÇÃO.
 *
 * Dois artefatos centrais:
 *  - `PaginaContrato`: a API-Doc (OpenAPI 3.1 + premissas + segurança + ramos +
 *    fluxo) — documentação legível por humano E por máquina. Imutável por versão.
 *  - `AdapterSpec`: descrição DECLARATIVA (whitelist de passos) executada por um
 *    runner genérico. NUNCA é código executável (sem eval) — auditável e seguro.
 *
 * Nada aqui toca o hot-path: o módulo é auto-contido e tudo é gated (FAIL-CLOSED).
 */

/** Operação que o portal cobre. */
export type Operacao = "consulta" | "cotacao" | "apolice";

/** Status de ciclo de vida (contrato e adapter). */
export type StatusArtefato = "rascunho" | "aprovado" | "arquivado";

// ── Premissas (pré-condições do processo) ──────────────────────────────────

/** Uma premissa observada (ex.: cpf_obrigatorio=true). `confianca ∈ [0,1]`. */
export interface Premissa {
  chave: string; // 'cpf_obrigatorio' | '2fa_required' | 'rate_limit' | ...
  valor: string | number | boolean;
  evidencia?: string; // onde foi observado (sem PII)
  confianca: number; // 0..1
}

// ── Segurança do portal (captcha, TLS, auth, criptografia) ─────────────────

export type TipoCaptcha = "recaptcha_v2" | "recaptcha_v3" | "hcaptcha" | "turnstile" | "honeypot" | "desconhecido";

export interface AnaliseSeguranca {
  /** login+senha SEMPRE obrigatório: esquema de autenticação detectado. */
  auth: {
    obrigatorio: boolean; // sempre true no nosso processo (premissa nº 0)
    esquema: "form_login" | "bearer_jwt" | "cookie_sessao" | "device_trust" | "desconhecido";
    expiraToken?: boolean;
  };
  twoFactor: { presente: boolean; metodo?: "email_otp" | "sms" | "app" | "push" | "desconhecido" };
  captcha: { presente: boolean; tipo?: TipoCaptcha; onde?: string };
  /** TLS em todas as chamadas; httpPuro sinaliza risco. */
  transporte: { tlsTudo: boolean; httpPuroEm: string[] };
  /** criptografia/assinatura a nível de aplicação (além do TLS). */
  criptografia: { payloadCifrado: boolean; assinaturaHmac: boolean; certPinning: boolean };
  /** PII que trafega (para LGPD/redação). */
  piiTrafegada: string[];
  /** se o portal blinda a interceptação (pinning/cifra) → cair para DOM/RPA. */
  interceptacaoLimitada: boolean;
}

// ── Endpoints / campos inferidos do tráfego ────────────────────────────────

export interface CampoDescoberto {
  nome: string; // chave no corpo da request
  tipo: "string" | "number" | "boolean" | "object" | "array";
  obrigatorio: boolean;
  pattern?: string; // ex.: regex de CPF
  exemploRedigido?: string; // valor de exemplo SEM PII
  confianca: number;
}

export interface EndpointDescoberto {
  metodo: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** já com path-templating: /users/123 → /users/{id} */
  pathTemplate: string;
  urlBase: string;
  auth: "bearer" | "cookie" | "none" | "desconhecido";
  campos: CampoDescoberto[];
  /** chaves observadas na resposta (para extração/poll). */
  respostaChaves: string[];
  papel?: "auth" | "catalogo" | "criar" | "calcular" | "poll" | "resultado" | "outro";
  confianca: number;
}

/** Uma etapa do fluxo observado (token→segurado→calculo→coleta…). */
export interface EtapaFluxo {
  ordem: number;
  nome: string;
  endpointPath: string;
  descricao?: string;
}

/** Item do catálogo de seguros detectado no portal. */
export interface RamoDisponivel {
  ramo: string; // slug normalizado (auto, residencial, vida, …) ou livre
  rotuloNoPortal: string;
  operacoes: Operacao[];
  statusSuporte: "suportado" | "parcial" | "nao_mapeado";
  premissasEspecificas?: Premissa[];
}

// ── AdapterSpec declarativo (executado pelo runner, SEM eval) ───────────────

/** Resolve `{{caminho}}` a partir do contexto (dados do cliente + vars). */
export type Template = string;

export interface PassoAuth {
  tipo: "auth";
  /** hoje só login HTTP; RPA fica no fallback agêntico. */
  metodo: "http_login";
  url: Template;
  corpo: Record<string, Template>;
  /** JSONPath simples (a.b.c) de onde extrair o token na resposta. */
  tokenPath: string;
  /** nome da variável onde guardar o token (default 'token'). */
  guardarEm?: string;
}

export interface PassoHttp {
  tipo: "http";
  metodo: "GET" | "POST" | "PUT" | "PATCH";
  url: Template;
  headers?: Record<string, Template>;
  corpo?: Record<string, Template> | Template;
  /** mapeia caminhos da resposta para variáveis: { idIntegracao: 'data.id' } */
  extrair?: Record<string, string>;
}

export interface PassoPoll {
  tipo: "poll";
  metodo: "GET" | "POST";
  url: Template;
  headers?: Record<string, Template>;
  intervaloMs: number;
  timeoutMs: number;
  /** caminho booleano/contagem que indica "pronto". */
  prontoQuando: { caminho: string; igualA?: string | number | boolean; existe?: boolean };
}

export interface PassoExtract {
  tipo: "extract";
  /** caminho até o array de resultados na última resposta. */
  arrayEm: string;
  /** mapeamento de campos do item → ResultadoCotacaoItem. */
  mapa: {
    seguradora: string;
    premio_total: string;
    parcelas?: string;
    valor_parcela?: string;
    coberturas_resumo?: string;
    status?: string;
  };
}

export type PassoAdapter = PassoAuth | PassoHttp | PassoPoll | PassoExtract;

// ── v2: passos DOM/RPA (executados pelo rpa-runner no daemon, Playwright) ────
// Whitelist; SEM eval. `seletor` pode ser estático OU um "papel" que o LLM
// resolve em runtime (reusa portal-selector.llm). Usados quando o portal não
// tem API limpa (emissão de apólice, formulários).

export interface PassoNavegar {
  tipo: "navegar";
  url: Template;
}
export interface PassoPreencher {
  tipo: "preencher";
  /** seletor estático OU papel (ex.: "campo_cpf") resolvido por LLM. */
  seletor: string;
  /** true = `seletor` é um papel a resolver via portal-selector.llm. */
  papel?: boolean;
  valor: Template;
  descricao?: string;
}
export interface PassoClicar {
  tipo: "clicar";
  seletor: string;
  papel?: boolean;
  descricao?: string;
  /** aguarda um download iniciar após o clique (ex.: botão "emitir"→PDF). */
  esperarDownload?: boolean;
}
export interface PassoEsperar {
  tipo: "esperar";
  ms?: number;
  seletor?: string;
  /** espera a URL SAIR de um padrão (ex.: deixar /login). */
  sairDeUrl?: string;
  timeoutMs?: number;
}
export interface PassoExtrairCampo {
  tipo: "extrair_campo";
  nome: string; // ex.: 'numeroApolice', 'premioTotal'
  /** seletor CSS OU regex de rótulo (ex.: "/ap[oó]lice|n[uú]mero/i"). */
  seletorOuRegex: string;
  comoMoeda?: boolean;
}
export interface PassoExtrairPdf {
  tipo: "extrair_pdf";
  /** se o PDF veio de um download disparado por um clique anterior. */
  doDownload?: boolean;
}

export type PassoRpa =
  | PassoNavegar
  | PassoPreencher
  | PassoClicar
  | PassoEsperar
  | PassoExtrairCampo
  | PassoExtrairPdf;

/** Objetivo do agente construtor (vira critério de parada). */
export type Objetivo = "validar_estrutura" | "consulta" | "cotacao" | "apolice";

/** Critério de sucesso (máquina-checável) por objetivo. */
export interface CriterioSucesso {
  objetivo: Objetivo;
  /** campos que precisam existir no resultado (ex.: ['numeroApolice','pdf']). */
  exige?: string[];
  /** para cotação: nº mínimo de itens 'cotado'. */
  minCotados?: number;
}

/** Caso de teste designado pelo operador (dados/proposta de validação). */
export interface CasoTeste {
  /** dados do cliente p/ cotação/cadastro (CPF/placa/CEP de teste). */
  dados?: Record<string, unknown>;
  /** nº/identificador da proposta de teste (objetivo apólice). */
  propostaTeste?: string;
  /** o operador CIENTE de que objetivo='apolice' emite 1 apólice real. */
  confirmaEmissaoReal?: boolean;
}

export interface AdapterSpec {
  sistema: string;
  ramo: string;
  operacao: Operacao;
  /** v2: objetivo perseguido (default = operacao). */
  objetivo?: Objetivo;
  /** v2: identidade canônica da seguradora (FK seguradoras_config.id). */
  seguradoraConfigId?: string | null;
  versao: number;
  /** mapeamento dados-do-cliente → variáveis de entrada (reusa mapper dinâmico). */
  entradaObrigatoria: string[]; // ex.: ['cpf','placa','cep']
  /** passos HTTP (cotação via API). */
  passos: PassoAdapter[];
  /** v2: passos DOM/RPA (emissão de apólice / formulário). */
  passosRpa?: PassoRpa[];
  /** política de resiliência. */
  resiliencia?: {
    maxRetries?: number; // default 3
    backoffBaseMs?: number; // default 500
    timeoutMsPadrao?: number; // default 30000
  };
}

// ── Contrato (API-Doc) ─────────────────────────────────────────────────────

export interface PaginaContrato {
  id?: string;
  corretoraId: string;
  sistema: string;
  ramo: string;
  operacao: Operacao;
  urlBase: string | null;
  versao: number;
  /** OpenAPI 3.1 (objeto). */
  openapi: Record<string, unknown>;
  premissas: Premissa[];
  ramosDisponiveis: RamoDisponivel[];
  seguranca: AnaliseSeguranca | Record<string, never>;
  fluxo: EtapaFluxo[];
  status: StatusArtefato;
  /** convergência entre capturas redundantes: 'estavel' | 'instavel'. */
  estabilidade?: "estavel" | "instavel";
}

// ── HAR (subconjunto que consumimos; tolerante) ────────────────────────────

export interface HarEntradaResumo {
  metodo: string;
  url: string;
  status: number;
  reqHeaders: Record<string, string>;
  /** corpo da request JÁ REDIGIDO (sem segredos/PII). */
  reqBody?: unknown;
  /** corpo da resposta JÁ REDIGIDO. */
  respBody?: unknown;
  respHeaders?: Record<string, string>;
}

export interface HarResumo {
  entradas: HarEntradaResumo[];
  /** links/itens de menu observados no DOM (para catálogo de ramos). */
  domLinks?: { texto: string; href: string }[];
}
