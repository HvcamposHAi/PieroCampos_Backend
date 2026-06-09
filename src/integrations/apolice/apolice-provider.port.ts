/**
 * Porta de PROVIDER de EMISSÃO de apólice — abstrai "como emitimos a apólice de
 * cada seguradora". Diferente da QuoteProvider (que roteia por RAMO), aqui a
 * escolha é por `grupo_integracao` da `seguradoras_config`:
 *   A_api → caminho HTTP (API da seguradora, onde houver);
 *   B_rpa → Playwright (raspagem do portal);
 *   C_otp → Playwright + OTP.
 *
 * O módulo é ISOLADO (não conhece Supabase): a service resolve a linha de
 * `seguradoras_config` e as credenciais (do cofre) e passa tudo como DADO. O
 * provider devolve o resultado estruturado + os bytes do PDF (a service sobe ao
 * storage e persiste). Espelha o padrão de quote-provider.port.ts.
 */
import type { PersistencePort } from "../segfy/persistence.port";

export type GrupoIntegracao = "A_api" | "B_rpa" | "C_otp";

/** Subconjunto da `seguradoras_config` que a emissão precisa (resolvido pela service). */
export interface SeguradoraConfigRef {
  id: string;
  corretoraId: string;
  nomeDisplay: string;
  grupoIntegracao: GrupoIntegracao;
  loginType: string | null;
  urlPortal: string | null;
  /** Ponteiro p/ cofre externo — NUNCA o segredo em si. */
  vaultKey: string | null;
  /** Caixa de e-mail p/ ler o OTP (grupo C_otp). */
  emailOtp: string | null;
  tipoAutenticacao: string | null;
}

/** Credenciais resolvidas (a service decifra do cofre; o módulo as recebe como dado). */
export interface CredenciaisPortal {
  usuario: string;
  senha: string;
  /** Campos extras por seguradora (ex.: código de corretor/CNPJ). */
  extra?: Record<string, string>;
}

export interface EmitirApoliceContext {
  corretoraId: string;
  seguradora: SeguradoraConfigRef;
  proposta: {
    /** propostas.id (nosso banco). */
    id: string;
    numeroProposta: string | null;
    clienteId: string;
    ramo: string;
    /** Liga as etapas de emissão ao realtime (cotacao_eventos). */
    cotacaoId: string | null;
  };
  credenciais: CredenciaisPortal;
  /** Para C_otp: callback que a service fornece (lê o e-mail/OTP). */
  obterOtp?: () => Promise<string>;
}

export interface EmitirApoliceResult {
  sucesso: boolean;
  numeroApolice: string | null;
  inicioVigencia: string | null; // ISO 8601
  fimVigencia: string | null; // ISO 8601
  premioTotal: number | null;
  premioLiquido: number | null;
  /** Bytes do PDF; a service sobe ao bucket (o módulo não toca storage). */
  pdf?: { bytes: Buffer; contentType: string } | null;
  /** Quando sucesso=false: código de máquina (ex.: "apolice_rpa_desabilitado", "portal_login_falhou"). */
  erro?: string;
  /** Detalhe humano-legível. NUNCA inclua credencial/OTP/token. */
  detalhe?: Record<string, unknown>;
}

export interface ApoliceProvider {
  /** Identificador legível (ex.: "apolice-api", "apolice-rpa", "apolice-rpa-otp"). */
  readonly nome: string;
  readonly grupo: GrupoIntegracao;
  /**
   * Emite a apólice. NUNCA lança por falha de portal: devolve `sucesso=false` +
   * `erro`. `persist` é opcional e serve só para registrar etapas (observabilidade);
   * a persistência de apólice/proposta é responsabilidade da service.
   */
  emitir(ctx: EmitirApoliceContext, persist?: PersistencePort): Promise<EmitirApoliceResult>;
}
