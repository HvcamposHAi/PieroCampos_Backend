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
  ClienteRef,
  IniciarCotacaoInput,
  PersistencePort,
  RegistrarEtapaInput,
  SalvarCotacaoInput,
  SegfySyncLogInput,
} from "../segfy/persistence.port";
import type { Database, Json } from "./supabase.types";

export class SupabasePersistence implements PersistencePort {
  private readonly supabase: SupabaseClient<Database>;

  constructor(client?: SupabaseClient<Database>) {
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

  async buscarClientePorId(id: string): Promise<ClienteRef | null> {
    const { data, error } = await this.supabase
      .from("clientes")
      .select("id,nome,cpf,email,telefone,segfy_id,consentimento_lgpd")
      .eq("id", id)
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
        cliente_id: input.clienteId,
        conversa_id: input.conversaId,
        ramo: input.ramo,
        dados_entrada: input.dadosEntrada as unknown as Json,
        resultados: input.resultados as unknown as Json,
        segfy_cotacao_id: input.segfyCotacaoId,
        validade_ate: input.validadeAte,
        status: "concluida",
      })
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
      operacao: input.operacao,
      via: input.via,
      ref_id: input.refId ?? null,
      sucesso: input.sucesso,
      detalhe: (input.detalhe ?? null) as Json | null,
    });
    if (error) {
      // Não relançar: falha no log de auditoria não deve abortar o fluxo de negócio.
      logger.warn("supabase: registrarLog falhou", { codigo: error.code });
    }
  }

  async iniciarCotacao(input: IniciarCotacaoInput): Promise<{ cotacaoId: string }> {
    // `origem` só é enviado quando informado (coluna opcional com default no banco).
    // Cast via Record para não acoplar ao types.ts antes da regeneração (cláusula B).
    const payload: Record<string, unknown> = {
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
      cotacao_id: input.cotacaoId ?? null,
      conversa_id: input.conversaId,
      etapa: input.etapa,
      status: input.status,
      mensagem: input.mensagem ?? null,
      detalhe: (input.detalhe ?? null) as Json | null,
    });
    if (error) {
      // Não-fatal: observabilidade não pode abortar a cotação.
      logger.warn("supabase: registrarEtapa falhou", { etapa: input.etapa, codigo: error.code });
    }
  }
}
