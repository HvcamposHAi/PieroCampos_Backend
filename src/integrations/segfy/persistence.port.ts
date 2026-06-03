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

/** Etapas do pipeline Segfy (área de consulta/observabilidade). */
export type EtapaSegfy = "token" | "segurado" | "veiculo" | "calculo" | "coleta" | "salvar";
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

export interface PersistencePort {
  buscarClientePorId(id: string): Promise<ClienteRef | null>;
  vincularSegfyIdAoCliente(clienteId: string, segfyId: string): Promise<void>;
  salvarCotacao(input: SalvarCotacaoInput): Promise<{ cotacaoId: string }>;
  registrarLog(input: SegfySyncLogInput): Promise<void>;
  /** Cria a cotação em 'processando' e devolve o id (para ligar etapas). */
  iniciarCotacao(input: IniciarCotacaoInput): Promise<{ cotacaoId: string }>;
  /** Atualiza status/resultados/ids da cotação ao concluir ou falhar. */
  atualizarCotacao(cotacaoId: string, patch: AtualizarCotacaoInput): Promise<void>;
  /** Registra uma etapa do pipeline Segfy (observabilidade na tela). */
  registrarEtapa(input: RegistrarEtapaInput): Promise<void>;
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
  private seq = 0;

  semearCliente(cliente: ClienteRef): void {
    this.clientes.set(cliente.id, cliente);
  }

  async buscarClientePorId(id: string): Promise<ClienteRef | null> {
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
}
