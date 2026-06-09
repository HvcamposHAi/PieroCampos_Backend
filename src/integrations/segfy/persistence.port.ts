/**
 * Porta de persistência — o módulo Segfy NÃO fala com o Supabase diretamente.
 *
 * No escopo isolado atual, o harness/testes injetam `InMemoryPersistence`.
 * Quando o bot real existir, ele injeta um adapter que escreve no Supabase
 * (com service_role). Isso mantém o módulo desacoplado e testável, e concentra
 * as invariantes de integridade (FK cliente_id, idempotência) numa interface.
 *
 * Os nomes de campo espelham o schema verificado em produção (= types.ts).
 */
import type { ResultadoCotacaoItem } from "./segfy.types";

export interface ClienteRef {
  id: string;
  nome: string | null;
  cpf: string | null;
  email: string | null;
  telefone: string;
  segfy_id: string | null;
  /** LGPD: só enviamos PII ao Segfy se houver consentimento. */
  consentimento_lgpd: boolean;
}

export interface SalvarCotacaoInput {
  conversaId: string | null;
  clienteId: string; // cotacoes.cliente_id é NOT NULL em produção
  ramo: string;
  dadosEntrada: Record<string, unknown>;
  resultados: ResultadoCotacaoItem[];
  segfyCotacaoId: string; // != segurado_id (corrige bug do MD §9)
  validadeAte: string; // ISO 8601
}

export type OperacaoSegfy = "segurado" | "cotacao" | "proposta" | "apolice" | "comissao";

export interface SegfySyncLogInput {
  operacao: OperacaoSegfy;
  via: "api" | "scraper";
  refId?: string;
  sucesso: boolean;
  /** NUNCA inclua token/senha aqui — o logger redige, mas a tabela persiste. */
  detalhe?: Record<string, unknown>;
}

/** Cria a cotação ANTES de chamar o Segfy (status 'processando') para que as
 *  etapas tenham a quem se ligar e a tela mostre "cotando de verdade". */
export interface IniciarCotacaoInput {
  conversaId: string | null;
  clienteId: string;
  ramo: string;
  dadosEntrada: Record<string, unknown>;
  /** 'whatsapp' (default no banco) ou 'manual' (cotação disparada pelo operador). */
  origem?: "whatsapp" | "manual";
}

export type StatusCotacaoDb = "pendente" | "processando" | "concluida" | "erro" | "expirada";

export interface AtualizarCotacaoInput {
  status?: StatusCotacaoDb;
  resultados?: ResultadoCotacaoItem[];
  segfyCotacaoId?: string;
  validadeAte?: string;
}

/** Etapas do pipeline Segfy (área de consulta/observabilidade). As 4 últimas são
 *  da EMISSÃO de apólice (reusam `cotacao_eventos`, cuja coluna `etapa` é texto). */
export type EtapaSegfy =
  | "token"
  | "segurado"
  | "veiculo"
  | "calculo"
  | "coleta"
  | "salvar"
  | "proposta"
  | "login"
  | "emissao"
  | "download";
export type StatusEtapa = "andamento" | "ok" | "erro";

export interface RegistrarEtapaInput {
  cotacaoId?: string | null;
  conversaId: string | null;
  etapa: EtapaSegfy;
  status: StatusEtapa;
  /** Crítica humano-legível. NUNCA inclua token/CPF. */
  mensagem?: string;
  detalhe?: Record<string, unknown>;
}

// ── EMISSÃO de apólice (proposta → apólice) + catálogo de seguradoras ─────────

export type StatusPropostaDb =
  | "pendente"
  | "transmitida"
  | "em_analise"
  | "pendencia_doc"
  | "pendencia_vistoria"
  | "problema_bonificacao"
  | "recusada"
  | "aprovada"
  | "emitida";

export interface SalvarPropostaInput {
  clienteId: string;
  cotacaoId: string | null;
  seguradora: string;
  numeroProposta?: string | null;
  /** default no adapter: 'transmitida'. */
  status?: StatusPropostaDb;
  operadorTransmissaoId?: string | null;
  observacao?: string | null;
}

export interface AtualizarPropostaInput {
  status?: StatusPropostaDb;
  pdfUrl?: string | null;
  emitidaEm?: string;
  transmitidaEm?: string;
}

/** Subconjunto da `propostas` que a emissão precisa (escopo já filtrado por corretora). */
export interface PropostaRef {
  id: string;
  clienteId: string;
  cotacaoId: string | null;
  ramo: string | null;
  seguradora: string;
  status: StatusPropostaDb;
  numeroProposta: string | null;
}

export interface SalvarApoliceInput {
  clienteId: string;
  propostaId: string;
  numeroApolice: string;
  ramo: string;
  seguradora: string;
  inicioVigencia: string | null;
  fimVigencia: string | null;
  premioTotal: number | null;
  premioLiquido: number | null;
  pdfUrl: string | null;
}

export type StatusAcessoDb = "ok" | "falha" | "credencial_expirada" | "instavel";

/** Linha de `seguradoras_config` (catálogo de seguradoras, por corretora). */
export interface SeguradoraConfigRow {
  id: string;
  nome_display: string;
  ativo: boolean;
  status_acesso: StatusAcessoDb;
  grupo_integracao: "A_api" | "B_rpa" | "C_otp";
  tipo_autenticacao: string | null;
  login_type: string | null;
  ramos: string[];
  email_otp: string | null;
  url_portal: string | null;
  vault_key: string | null;
  observacao_tecnica: string | null;
  ultimo_acesso: string | null;
}

export interface AtualizarSeguradoraConfigInput {
  ativo?: boolean;
  grupo_integracao?: "A_api" | "B_rpa" | "C_otp";
  tipo_autenticacao?: string | null;
  login_type?: string | null;
  url_portal?: string | null;
  email_otp?: string | null;
  observacao_tecnica?: string | null;
}

export interface PersistencePort {
  /** corretoraId (opcional): defesa-em-profundidade — só devolve o cliente se
   *  pertencer à corretora. Quando omitido, o adapter usa a corretora do escopo. */
  buscarClientePorId(id: string, corretoraId?: string): Promise<ClienteRef | null>;
  vincularSegfyIdAoCliente(clienteId: string, segfyId: string): Promise<void>;
  salvarCotacao(input: SalvarCotacaoInput): Promise<{ cotacaoId: string }>;
  registrarLog(input: SegfySyncLogInput): Promise<void>;
  /** Cria a cotação em 'processando' e devolve o id (para ligar etapas). */
  iniciarCotacao(input: IniciarCotacaoInput): Promise<{ cotacaoId: string }>;
  /** Atualiza status/resultados/ids da cotação ao concluir ou falhar. */
  atualizarCotacao(cotacaoId: string, patch: AtualizarCotacaoInput): Promise<void>;
  /** Registra uma etapa do pipeline Segfy (observabilidade na tela). */
  registrarEtapa(input: RegistrarEtapaInput): Promise<void>;

  // Emissão de apólice
  salvarProposta(input: SalvarPropostaInput): Promise<{ propostaId: string }>;
  buscarProposta(propostaId: string): Promise<PropostaRef | null>;
  atualizarPropostaStatus(propostaId: string, patch: AtualizarPropostaInput): Promise<void>;
  salvarApolice(input: SalvarApoliceInput): Promise<{ apoliceId: string }>;

  // Catálogo de seguradoras (tela /seguradoras + status via "Testar")
  listarSeguradorasConfig(): Promise<SeguradoraConfigRow[]>;
  buscarSeguradoraConfigPorId(id: string): Promise<SeguradoraConfigRow | null>;
  buscarSeguradoraConfigPorNome(nomeDisplay: string): Promise<SeguradoraConfigRow | null>;
  atualizarSeguradoraConfig(id: string, patch: AtualizarSeguradoraConfigInput): Promise<void>;
  /** Única escrita em `status_acesso` (botão "Testar"); atualiza `ultimo_acesso`. */
  registrarStatusAcesso(id: string, status: StatusAcessoDb, quando: string): Promise<void>;
}

/**
 * Implementação em memória para harness e testes.
 * Expõe os dados gravados via getters para asserção nos testes E2E.
 */
export class InMemoryPersistence implements PersistencePort {
  private clientes = new Map<string, ClienteRef>();
  readonly cotacoesSalvas: Array<SalvarCotacaoInput & { cotacaoId: string }> = [];
  readonly logs: SegfySyncLogInput[] = [];
  readonly cotacoesIniciadas: Array<IniciarCotacaoInput & { cotacaoId: string }> = [];
  readonly cotacoesAtualizadas: Array<{ cotacaoId: string } & AtualizarCotacaoInput> = [];
  readonly etapas: RegistrarEtapaInput[] = [];
  readonly propostasSalvas: Array<SalvarPropostaInput & { propostaId: string }> = [];
  readonly propostasAtualizadas: Array<{ propostaId: string } & AtualizarPropostaInput> = [];
  readonly apolicesSalvas: Array<SalvarApoliceInput & { apoliceId: string }> = [];
  readonly statusAcessoRegistrado: Array<{ id: string; status: StatusAcessoDb; quando: string }> = [];
  readonly configsAtualizadas: Array<{ id: string } & AtualizarSeguradoraConfigInput> = [];
  private seguradorasConfig: SeguradoraConfigRow[] = [];
  private propostas = new Map<string, PropostaRef>();
  private seq = 0;

  semearCliente(cliente: ClienteRef): void {
    this.clientes.set(cliente.id, cliente);
  }

  semearSeguradoraConfig(row: SeguradoraConfigRow): void {
    this.seguradorasConfig.push(row);
  }

  semearProposta(proposta: PropostaRef): void {
    this.propostas.set(proposta.id, proposta);
  }

  async buscarClientePorId(id: string, _corretoraId?: string): Promise<ClienteRef | null> {
    return this.clientes.get(id) ?? null;
  }

  async vincularSegfyIdAoCliente(clienteId: string, segfyId: string): Promise<void> {
    const c = this.clientes.get(clienteId);
    if (c) c.segfy_id = segfyId;
  }

  async salvarCotacao(input: SalvarCotacaoInput): Promise<{ cotacaoId: string }> {
    const cotacaoId = `cot_${++this.seq}`;
    this.cotacoesSalvas.push({ ...input, cotacaoId });
    return { cotacaoId };
  }

  async registrarLog(input: SegfySyncLogInput): Promise<void> {
    this.logs.push(input);
  }

  async iniciarCotacao(input: IniciarCotacaoInput): Promise<{ cotacaoId: string }> {
    const cotacaoId = `cot_${++this.seq}`;
    this.cotacoesIniciadas.push({ ...input, cotacaoId });
    return { cotacaoId };
  }

  async atualizarCotacao(cotacaoId: string, patch: AtualizarCotacaoInput): Promise<void> {
    this.cotacoesAtualizadas.push({ cotacaoId, ...patch });
  }

  async registrarEtapa(input: RegistrarEtapaInput): Promise<void> {
    this.etapas.push(input);
  }

  async salvarProposta(input: SalvarPropostaInput): Promise<{ propostaId: string }> {
    const propostaId = `prop_${++this.seq}`;
    this.propostasSalvas.push({ ...input, propostaId });
    this.propostas.set(propostaId, {
      id: propostaId,
      clienteId: input.clienteId,
      cotacaoId: input.cotacaoId,
      ramo: null,
      seguradora: input.seguradora,
      status: input.status ?? "transmitida",
      numeroProposta: input.numeroProposta ?? null,
    });
    return { propostaId };
  }

  async buscarProposta(propostaId: string): Promise<PropostaRef | null> {
    return this.propostas.get(propostaId) ?? null;
  }

  async atualizarPropostaStatus(propostaId: string, patch: AtualizarPropostaInput): Promise<void> {
    this.propostasAtualizadas.push({ propostaId, ...patch });
    const p = this.propostas.get(propostaId);
    if (p && patch.status) p.status = patch.status;
  }

  async salvarApolice(input: SalvarApoliceInput): Promise<{ apoliceId: string }> {
    const apoliceId = `apo_${++this.seq}`;
    this.apolicesSalvas.push({ ...input, apoliceId });
    return { apoliceId };
  }

  async listarSeguradorasConfig(): Promise<SeguradoraConfigRow[]> {
    return [...this.seguradorasConfig];
  }

  async buscarSeguradoraConfigPorId(id: string): Promise<SeguradoraConfigRow | null> {
    return this.seguradorasConfig.find((s) => s.id === id) ?? null;
  }

  async buscarSeguradoraConfigPorNome(nomeDisplay: string): Promise<SeguradoraConfigRow | null> {
    const alvo = nomeDisplay.trim().toLowerCase();
    return this.seguradorasConfig.find((s) => s.nome_display.trim().toLowerCase() === alvo) ?? null;
  }

  async atualizarSeguradoraConfig(id: string, patch: AtualizarSeguradoraConfigInput): Promise<void> {
    this.configsAtualizadas.push({ id, ...patch });
    const row = this.seguradorasConfig.find((s) => s.id === id);
    if (row) Object.assign(row, patch);
  }

  async registrarStatusAcesso(id: string, status: StatusAcessoDb, quando: string): Promise<void> {
    this.statusAcessoRegistrado.push({ id, status, quando });
    const row = this.seguradorasConfig.find((s) => s.id === id);
    if (row) {
      row.status_acesso = status;
      row.ultimo_acesso = quando;
    }
  }
}
