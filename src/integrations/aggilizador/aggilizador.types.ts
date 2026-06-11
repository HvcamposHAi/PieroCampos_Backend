/**
 * Tipos dos payloads/respostas do Aggilizador — derivados do HAR de sessão real
 * (11/06/2026). Reusa `ResultadoCotacaoItem` do Segfy (contrato único de
 * comparativo): a aba Cotações/Etapas e o formatador de WhatsApp não distinguem
 * o sistema de origem.
 *
 * ✅ A forma do item de POLLING com `retorno:true` (premio anual no raiz =
 * plano `principal`; detalhe em `resultados[].{coberturas,parcelamentos}`) está
 * CONFIRMADA no HAR de cotação concluída (11/06/2026). Resta VALIDAR-LIVE só o
 * formato do `idIntegracao` por seguradora no payload de `calcularV2` e o domínio
 * numérico de `estadoCivil`. Enquanto `AGGILIZADOR_ENABLED=false`, nada roda.
 */

// Reexporta o contrato de resultado (mesmo do Segfy) p/ o módulo ser autocontido.
export type { ResultadoCotacaoItem } from "../segfy/segfy.types";

// ── Autenticação ─────────────────────────────────────────────────────────────

/** Tokens + contexto de uma sessão autenticada (dois JWTs, dois backends). */
export interface AggilizadorSessao {
  /** JWT do host PROD (api-prod.aggilizador.com.br). */
  tokenPrincipal: string;
  /** JWT do motor Multicálculo (api.multicalculo.net), via /usuario/login/pdocs. */
  tokenMulticalculo: string;
  corretoraId: string;
  /** Expiração do token principal (epoch ms — NÃO segundos; ver auth). */
  expires: number;
  /** Expiração do token do multicálculo (epoch ms). */
  expiresMulticalculo: number;
}

/**
 * Resposta do POST /usuario/login?device=desktop (HTTP 201).
 * ⚠️ Observado em prod: o envelope VARIA. Login limpo vem ~flat (`{token,...}`);
 * mas há um envelope `{ message, data:{...}, idUsuarioAgger, assinaturaId }` (ex.:
 * "Já existe uma sessão ativa com esse usuário."). Por isso os campos são opcionais
 * e o parser (`aggilizador.auth`) lê do topo OU de `data`, com `message` p/ diagnose.
 */
export interface AggilizadorLoginResponse {
  token?: string;
  expires?: number; // epoch ms
  corretoraId?: string;
  statusCorretora?: number; // 1 = ativa
  expirationDate?: string;
  permissoesCorretora?: Record<string, { id: number; contratado: boolean } | unknown>;
  /** Envelope alternativo: campos aninhados em `data`. */
  data?: Record<string, unknown>;
  /** Mensagem de negócio (ex.: sessão já ativa). */
  message?: string;
}

/** Resposta do POST /usuario/login/pdocs (HTTP 201). */
export interface AggilizadorPdocsResponse {
  token?: string;
  expires?: number; // epoch ms
  corretoraId?: string;
  data?: Record<string, unknown>;
  message?: string;
}

// ── Config / lookups ─────────────────────────────────────────────────────────

/** Item de /cfg/seguradora/config — credenciais por seguradora da corretora. */
export interface SeguradoraConfigItem {
  nomeSeguradora: string;
  login: string;
  senha: string;
  seguradora: number; // ID numérico interno
  ativo: boolean;
  credenciaisValidas: boolean;
  percComissao: number | null;
  percDesconto: number | null;
}

/** Resposta de /cadastros/cliente (pré-preenchimento; pode vir parcial/null). */
export interface CadastroClienteResponse {
  nome?: string | null;
  cpfCnpj?: string | null;
  sexo?: string | null; // "M" | "F"
  dataNas?: string | null; // YYYY-MM-DD
  fone?: string | null;
}

/** Item de /calculo/cep. */
export interface CepResponse {
  cep: string;
  logradouro?: string;
  cidade?: string;
  bairro?: string;
  uf?: string;
}

/** Resposta de /calculo/buscaPlaca. */
export interface BuscaPlacaResponse {
  fipe: string;
  anoMod: string;
  anoFab: string;
  tipoVeic: string; // "v" leve | "m" moto | "c" caminhão
  placa?: string;
  chassi?: string;
  codFabr?: number;
  modelo?: string;
}

// ── Disparo (calcularV2) ─────────────────────────────────────────────────────

/** Segurado do payload de cálculo. */
export interface SeguradoPayload {
  nome: string;
  tipoPessoa: "F" | "J";
  cpfCnpj: string;
  estadoCivil: number;
  dataNasc: string; // ISO 8601
  sexo: string; // "M" | "F"
  fone1: string;
  cep: string;
  email: string;
  uf: string;
  cidade: string;
  bairro: string;
  logradouro: string;
  isPCD: boolean;
}

/** Veículo do payload de cálculo. */
export interface AutomovelPayload {
  fipe: string;
  anoMod: string;
  anoFab: string;
  placa: string;
  tipoVeic: string;
  chassi?: string;
  modelo?: string;
  codFabr?: number;
  valorDeNovo: number;
}

/** Coberturas (valores observados na sessão; defaults em `aggilizador.coberturas.ts`). */
export interface CoberturasPayload {
  tipoCobertura: number;
  tipoFranquia: number;
  isDanosMateriais: number;
  isDanosCorporais: number;
  isDanosMorais: number;
  isAppMorte: number;
  isBlindagemValor: number;
  carroReserva: number;
  carroReservaAr: boolean;
  despesasExtra: boolean;
  protecaoPneuRodas: boolean;
  reparoRapido: boolean;
  vidros: number;
  assist24hs: number;
}

/** Uma entrada de `calculos[]`: coberturas + credenciais da seguradora. */
export type CalculoSeguradora = CoberturasPayload & {
  ativo: boolean;
  nome: string;
  nomeSeguradora: string;
  login: string;
  senha: string;
  seguradora: number;
  idIntegracao?: string;
  percComissao: number;
  percDesconto: number;
  configsGlobais: boolean;
  credenciaisValidas: boolean;
  valorDeNovo: number;
};

/** Payload completo do POST /calculo/calcularV2. */
export interface CalcularV2Payload {
  cotacao: {
    segurado: SeguradoPayload;
    calculos: CalculoSeguradora[];
    automovel: AutomovelPayload;
    coberturas: CoberturasPayload;
  };
}

/** Resposta do POST /calculo/calcularV2. */
export interface CalcularV2Response {
  idIntegracao: string;
  versao: number;
}

// ── Polling ──────────────────────────────────────────────────────────────────

/** Um plano/pacote ofertado por uma seguradora (item de `resultados[]`). */
export interface PlanoResultado {
  principal?: boolean;
  selected?: boolean;
  identificacao?: string | null;
  /** Prêmio anual do plano em R$. */
  premio?: number | null;
  /** ≈ premio/12 (indicativo). */
  premioMensal?: number | null;
  franquia?: number | null;
  /** Nº do cálculo na seguradora — necessário p/ transmissão de proposta (futuro). */
  nroCalculo?: string | null;
  /** Nome do PDF do orçamento (download futuro). */
  pdfFileNameAgger?: string | null;
  coberturas?: Record<string, unknown>;
  /** [{ parcelas, premioPrimeiraParc, premioDemaisParc, tipoPag }] — tipoPag 1=cartão. */
  parcelamentos?: Array<Record<string, unknown>> | null;
}

/**
 * Item do GET /calculo/cotacao/calculos/{id}/{versao} — ✅ forma confirmada no
 * HAR de cotação concluída. `retorno:true` + `premio:0` + `resultados:[]` =
 * seguradora respondeu sem oferta (recusa, não erro).
 */
export interface PollingItem {
  seguradoraTxt: string;
  seguradora?: number;
  retorno: boolean;
  retornoErro: boolean;
  /** Prêmio anual do plano `principal` em R$. */
  premio: number;
  premioMensal?: number | null;
  dataHoraEnvio?: string | null;
  dataHoraRetorno?: string | null;
  tempoResposta?: number | null;
  mensagem?: string | null;
  /** Planos ofertados; o `principal:true` é o destaque. */
  resultados?: PlanoResultado[] | null;
  [extra: string]: unknown;
}
