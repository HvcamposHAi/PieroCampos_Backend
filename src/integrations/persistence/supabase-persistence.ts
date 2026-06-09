/**
 * Adapter Supabase da PersistencePort do módulo Segfy.
 *
 * Usa a service_role key (bypassa RLS — apenas no backend), gravando em
 * `clientes`, `cotacoes` e `segfy_sync_log` exatamente nas colunas confirmadas
 * em produção. NÃO é instanciado nos testes do módulo Segfy (que continuam
 * usando InMemoryPersistence); só entra em ação quando o bot real injetar este
 * adapter no SegfyClient.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import type {
  AtualizarCotacaoInput,
  AtualizarPropostaInput,
  AtualizarSeguradoraConfigInput,
  ClienteRef,
  IniciarCotacaoInput,
  PersistencePort,
  PropostaRef,
  RegistrarEtapaInput,
  SalvarApoliceInput,
  SalvarCotacaoInput,
  SalvarPropostaInput,
  SeguradoraConfigRow,
  SegfySyncLogInput,
  StatusAcessoDb,
} from "../segfy/persistence.port";
import type { Database, Json } from "./supabase.types";

/** uuid LITERAL da corretora seed (Piero). Espelha o default de CORRETORA_SEED_ID. */
export const CORRETORA_SEED_ID = "00000000-0000-0000-0000-000000000001";

/** Lê o seed do ambiente sem acionar a validação completa de getEnv() (que pode
 *  lançar em testes que injetam um client fake sem env de Supabase). */
function lerCorretoraSeed(): string {
  const v = process.env.CORRETORA_SEED_ID;
  return v && v.trim() !== "" ? v.trim() : CORRETORA_SEED_ID;
}

export class SupabasePersistence implements PersistencePort {
  private readonly supabase: SupabaseClient<Database>;
  /**
   * Corretora (tenant) deste fluxo de cotação. Como o backend usa service_role
   * (bypassa RLS), o isolamento é manual: TODO insert carrega esta corretora e a
   * leitura de cliente é filtrada por ela. Default = corretora seed (Piero), que
   * reproduz o comportamento mono-tenant atual até os callers passarem o id real.
   */
  private readonly corretoraId: string;

  constructor(client?: SupabaseClient<Database>, corretoraId?: string) {
    // CORRETORA_SEED_ID tem default no schema; getEnv() pode falhar se WA_ENABLED
    // e faltar env (ex.: testes que injetam client). Por isso resolvemos com try.
    this.corretoraId = corretoraId ?? lerCorretoraSeed();
    if (client) {
      this.supabase = client;
      return;
    }
    const env = getEnv();
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error(
        "SupabasePersistence: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.",
      );
    }
    this.supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async buscarClientePorId(id: string, corretoraId?: string): Promise<ClienteRef | null> {
    const { data, error } = await this.supabase
      .from("clientes")
      .select("id,nome,cpf,email,telefone,segfy_id,consentimento_lgpd")
      .eq("id", id)
      // Isolamento de tenant: nunca devolve cliente de outra corretora. Cast
      // porque `corretora_id` só entra no types.ts após a regeneração (cláusula B).
      .eq("corretora_id" as never, (corretoraId ?? this.corretoraId) as never)
      // Soft-delete: nunca enviar PII de cliente já excluído ao Segfy (LGPD).
      .is("deletado_em", null)
      .maybeSingle();

    if (error) {
      logger.error("supabase: buscarClientePorId falhou", { id, codigo: error.code });
      throw error;
    }
    if (!data) return null;

    return {
      id: data.id,
      nome: data.nome,
      cpf: data.cpf,
      email: data.email,
      telefone: data.telefone,
      segfy_id: data.segfy_id,
      consentimento_lgpd: data.consentimento_lgpd,
    };
  }

  async vincularSegfyIdAoCliente(clienteId: string, segfyId: string): Promise<void> {
    const { error } = await this.supabase
      .from("clientes")
      .update({ segfy_id: segfyId })
      .eq("id", clienteId);
    if (error) {
      logger.error("supabase: vincularSegfyIdAoCliente falhou", { clienteId, codigo: error.code });
      throw error;
    }
  }

  async salvarCotacao(input: SalvarCotacaoInput): Promise<{ cotacaoId: string }> {
    const { data, error } = await this.supabase
      .from("cotacoes")
      .insert({
        corretora_id: this.corretoraId,
        cliente_id: input.clienteId,
        conversa_id: input.conversaId,
        ramo: input.ramo,
        dados_entrada: input.dadosEntrada as unknown as Json,
        resultados: input.resultados as unknown as Json,
        segfy_cotacao_id: input.segfyCotacaoId,
        validade_ate: input.validadeAte,
        status: "concluida",
      } as never)
      .select("id")
      .single();

    if (error || !data) {
      logger.error("supabase: salvarCotacao falhou", { codigo: error?.code });
      throw error ?? new Error("salvarCotacao: insert sem retorno");
    }
    return { cotacaoId: data.id };
  }

  async registrarLog(input: SegfySyncLogInput): Promise<void> {
    const { error } = await this.supabase.from("segfy_sync_log").insert({
      corretora_id: this.corretoraId,
      operacao: input.operacao,
      via: input.via,
      ref_id: input.refId ?? null,
      sucesso: input.sucesso,
      detalhe: (input.detalhe ?? null) as Json | null,
    } as never);
    if (error) {
      // Não relançar: falha no log de auditoria não deve abortar o fluxo de negócio.
      logger.warn("supabase: registrarLog falhou", { codigo: error.code });
    }
  }

  async iniciarCotacao(input: IniciarCotacaoInput): Promise<{ cotacaoId: string }> {
    // `origem` só é enviado quando informado (coluna opcional com default no banco).
    // Cast via Record para não acoplar ao types.ts antes da regeneração (cláusula B).
    const payload: Record<string, unknown> = {
      corretora_id: this.corretoraId,
      cliente_id: input.clienteId,
      conversa_id: input.conversaId,
      ramo: input.ramo,
      dados_entrada: input.dadosEntrada as unknown as Json,
      status: "processando",
    };
    if (input.origem) payload.origem = input.origem;
    const { data, error } = await this.supabase
      .from("cotacoes")
      .insert(payload as never)
      .select("id")
      .single();
    if (error || !data) {
      logger.error("supabase: iniciarCotacao falhou", { codigo: error?.code });
      throw error ?? new Error("iniciarCotacao: insert sem retorno");
    }
    return { cotacaoId: data.id };
  }

  async atualizarCotacao(cotacaoId: string, patch: AtualizarCotacaoInput): Promise<void> {
    const update: Record<string, unknown> = {};
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.resultados !== undefined) update.resultados = patch.resultados as unknown as Json;
    if (patch.segfyCotacaoId !== undefined) update.segfy_cotacao_id = patch.segfyCotacaoId;
    if (patch.validadeAte !== undefined) update.validade_ate = patch.validadeAte;
    const { error } = await this.supabase
      .from("cotacoes")
      .update(update as never)
      .eq("id", cotacaoId);
    if (error) {
      logger.error("supabase: atualizarCotacao falhou", { cotacaoId, codigo: error.code });
      throw error;
    }
  }

  async registrarEtapa(input: RegistrarEtapaInput): Promise<void> {
    const { error } = await this.supabase.from("cotacao_eventos").insert({
      corretora_id: this.corretoraId,
      cotacao_id: input.cotacaoId ?? null,
      conversa_id: input.conversaId,
      etapa: input.etapa,
      status: input.status,
      mensagem: input.mensagem ?? null,
      detalhe: (input.detalhe ?? null) as Json | null,
    } as never);
    if (error) {
      // Não-fatal: observabilidade não pode abortar a cotação.
      logger.warn("supabase: registrarEtapa falhou", { etapa: input.etapa, codigo: error.code });
    }
  }

  // ── Emissão de apólice ──────────────────────────────────────────────────────

  async salvarProposta(input: SalvarPropostaInput): Promise<{ propostaId: string }> {
    const agora = new Date().toISOString();
    const status = input.status ?? "transmitida";
    const payload: Record<string, unknown> = {
      corretora_id: this.corretoraId,
      cliente_id: input.clienteId,
      cotacao_id: input.cotacaoId,
      seguradora: input.seguradora,
      numero_proposta: input.numeroProposta ?? null,
      status,
      operador_transmissao_id: input.operadorTransmissaoId ?? null,
      observacao: input.observacao ?? null,
    };
    // transmitida_em só quando já nasce transmitida (coerência com o status).
    if (status === "transmitida") payload.transmitida_em = agora;
    const { data, error } = await this.supabase
      .from("propostas")
      .insert(payload as never)
      .select("id")
      .single();
    if (error || !data) {
      logger.error("supabase: salvarProposta falhou", { codigo: error?.code });
      throw error ?? new Error("salvarProposta: insert sem retorno");
    }
    return { propostaId: (data as { id: string }).id };
  }

  async buscarProposta(propostaId: string): Promise<PropostaRef | null> {
    const { data, error } = await this.supabase
      .from("propostas")
      .select("id,cliente_id,cotacao_id,seguradora,status,numero_proposta,cotacoes(ramo)")
      .eq("id", propostaId)
      .eq("corretora_id" as never, this.corretoraId as never)
      .is("deletado_em", null)
      .maybeSingle();
    if (error) {
      logger.error("supabase: buscarProposta falhou", { propostaId, codigo: error.code });
      throw error;
    }
    if (!data) return null;
    const r = data as unknown as {
      id: string;
      cliente_id: string;
      cotacao_id: string | null;
      seguradora: string;
      status: PropostaRef["status"];
      numero_proposta: string | null;
      cotacoes: { ramo: string | null } | null;
    };
    return {
      id: r.id,
      clienteId: r.cliente_id,
      cotacaoId: r.cotacao_id,
      ramo: r.cotacoes?.ramo ?? null,
      seguradora: r.seguradora,
      status: r.status,
      numeroProposta: r.numero_proposta,
    };
  }

  async atualizarPropostaStatus(propostaId: string, patch: AtualizarPropostaInput): Promise<void> {
    const update: Record<string, unknown> = {};
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.pdfUrl !== undefined) update.pdf_url = patch.pdfUrl;
    if (patch.emitidaEm !== undefined) update.emitida_em = patch.emitidaEm;
    if (patch.transmitidaEm !== undefined) update.transmitida_em = patch.transmitidaEm;
    // Idempotência da emissão: só transita p/ 'emitida' a partir de 'aprovada'
    // (evita re-emissão por duplo clique). Demais updates não filtram por status.
    let q = this.supabase.from("propostas").update(update as never).eq("id", propostaId);
    if (patch.status === "emitida") q = q.eq("status" as never, "aprovada" as never);
    // Isolamento de tenant (service_role bypassa RLS).
    q = q.eq("corretora_id" as never, this.corretoraId as never);
    const { error } = await q;
    if (error) {
      logger.error("supabase: atualizarPropostaStatus falhou", { propostaId, codigo: error.code });
      throw error;
    }
  }

  async salvarApolice(input: SalvarApoliceInput): Promise<{ apoliceId: string }> {
    const { data, error } = await this.supabase
      .from("apolices")
      .insert({
        corretora_id: this.corretoraId,
        cliente_id: input.clienteId,
        proposta_id: input.propostaId,
        numero_apolice: input.numeroApolice,
        ramo: input.ramo,
        seguradora: input.seguradora,
        inicio_vigencia: input.inicioVigencia,
        fim_vigencia: input.fimVigencia,
        premio_total: input.premioTotal,
        premio_liquido: input.premioLiquido,
        pdf_url: input.pdfUrl,
      } as never)
      .select("id")
      .single();
    if (error || !data) {
      logger.error("supabase: salvarApolice falhou", { codigo: error?.code });
      throw error ?? new Error("salvarApolice: insert sem retorno");
    }
    return { apoliceId: (data as { id: string }).id };
  }

  // ── Catálogo de seguradoras (seguradoras_config) ────────────────────────────

  private readonly SEG_COLS =
    "id,nome_display,ativo,status_acesso,grupo_integracao,tipo_autenticacao,login_type,ramos,email_otp,url_portal,url_emissao,vault_key,observacao_tecnica,ultimo_acesso";

  async listarSeguradorasConfig(): Promise<SeguradoraConfigRow[]> {
    const { data, error } = await this.supabase
      .from("seguradoras_config")
      .select(this.SEG_COLS)
      .eq("corretora_id" as never, this.corretoraId as never)
      .order("nome_display", { ascending: true });
    if (error) {
      logger.error("supabase: listarSeguradorasConfig falhou", { codigo: error.code });
      throw error;
    }
    return (data ?? []) as unknown as SeguradoraConfigRow[];
  }

  async buscarSeguradoraConfigPorId(id: string): Promise<SeguradoraConfigRow | null> {
    const { data, error } = await this.supabase
      .from("seguradoras_config")
      .select(this.SEG_COLS)
      .eq("id", id)
      .eq("corretora_id" as never, this.corretoraId as never)
      .maybeSingle();
    if (error) {
      logger.error("supabase: buscarSeguradoraConfigPorId falhou", { codigo: error.code });
      throw error;
    }
    return (data as unknown as SeguradoraConfigRow) ?? null;
  }

  async buscarSeguradoraConfigPorNome(nomeDisplay: string): Promise<SeguradoraConfigRow | null> {
    const { data, error } = await this.supabase
      .from("seguradoras_config")
      .select(this.SEG_COLS)
      .eq("corretora_id" as never, this.corretoraId as never)
      .ilike("nome_display", nomeDisplay)
      .maybeSingle();
    if (error) {
      logger.error("supabase: buscarSeguradoraConfigPorNome falhou", { codigo: error.code });
      throw error;
    }
    return (data as unknown as SeguradoraConfigRow) ?? null;
  }

  async atualizarSeguradoraConfig(id: string, patch: AtualizarSeguradoraConfigInput): Promise<void> {
    const update: Record<string, unknown> = { atualizado_em: new Date().toISOString() };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) update[k] = v;
    }
    const { error } = await this.supabase
      .from("seguradoras_config")
      .update(update as never)
      .eq("id", id)
      .eq("corretora_id" as never, this.corretoraId as never);
    if (error) {
      logger.error("supabase: atualizarSeguradoraConfig falhou", { id, codigo: error.code });
      throw error;
    }
  }

  async registrarStatusAcesso(id: string, status: StatusAcessoDb, quando: string): Promise<void> {
    const { error } = await this.supabase
      .from("seguradoras_config")
      .update({ status_acesso: status, ultimo_acesso: quando, atualizado_em: quando } as never)
      .eq("id", id)
      .eq("corretora_id" as never, this.corretoraId as never);
    if (error) {
      logger.error("supabase: registrarStatusAcesso falhou", { id, codigo: error.code });
      throw error;
    }
  }
}
