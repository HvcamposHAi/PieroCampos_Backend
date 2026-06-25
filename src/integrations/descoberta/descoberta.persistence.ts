/**
 * Persistência do módulo DESCOBERTA (service_role; escopo por corretora).
 *
 * Tabelas (cláusulas A–D): pagina_contrato, adapter_spec, descoberta_execucao,
 * descoberta_config. Versionamento IMUTÁVEL: nova descoberta cria versao = max+1
 * (nunca sobrescreve contrato aprovado). Invariante de 1 adapter ativo por
 * (corretora,sistema,ramo,operacao) é garantida por índice parcial no DDL +
 * `ativarAdapter` (desativa os demais antes de ativar).
 *
 * O cliente Supabase é injetável (deps.sb) para teste sem rede; default =
 * getSupabaseAdmin(). Toda escrita carrega `corretora_id` (multi-tenant).
 */
import { getSupabaseAdmin } from "../whatsapp/supabase";
import { logger } from "../../utils/logger";
import { _resetDescobertaCache } from "./descoberta.service";
import type { AdapterSpec, Operacao, PaginaContrato } from "./descoberta.types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;
export interface PersistDeps {
  sb?: Sb;
}
function cliente(deps?: PersistDeps): Sb {
  return deps?.sb ?? getSupabaseAdmin();
}

// ── Contrato (API-Doc) ─────────────────────────────────────────────────────

export interface ContratoRow {
  id: string;
  sistema: string;
  ramo: string;
  operacao: string;
  url_base: string | null;
  versao: number;
  openapi: unknown;
  premissas: unknown;
  ramos_disponiveis: unknown;
  seguranca: unknown;
  fluxo: unknown;
  status: string;
  atualizado_em: string;
}

async function proximaVersao(sb: Sb, corretoraId: string, sistema: string, ramo: string, operacao: string): Promise<number> {
  const { data } = await sb
    .from("pagina_contrato")
    .select("versao")
    .eq("corretora_id", corretoraId)
    .eq("sistema", sistema)
    .eq("ramo", ramo)
    .eq("operacao", operacao)
    .order("versao", { ascending: false })
    .limit(1)
    .maybeSingle();
  const atual = (data as { versao?: number } | null)?.versao ?? 0;
  return atual + 1;
}

/** Salva um contrato como nova VERSÃO (rascunho). Retorna o id criado. */
export async function salvarContrato(contrato: PaginaContrato, deps?: PersistDeps): Promise<{ contratoId: string; versao: number }> {
  const sb = cliente(deps);
  const versao = await proximaVersao(sb, contrato.corretoraId, contrato.sistema, contrato.ramo, contrato.operacao);
  const { data, error } = await sb
    .from("pagina_contrato")
    .insert({
      corretora_id: contrato.corretoraId,
      sistema: contrato.sistema,
      ramo: contrato.ramo,
      operacao: contrato.operacao,
      url_base: contrato.urlBase,
      versao,
      openapi: contrato.openapi,
      premissas: contrato.premissas,
      ramos_disponiveis: contrato.ramosDisponiveis,
      seguranca: contrato.seguranca,
      fluxo: contrato.fluxo,
      status: "rascunho",
    })
    .select("id")
    .single();
  if (error) throw error;
  return { contratoId: (data as { id: string }).id, versao };
}

export async function listarContratos(corretoraId: string, deps?: PersistDeps): Promise<ContratoRow[]> {
  const sb = cliente(deps);
  const { data, error } = await sb
    .from("pagina_contrato")
    .select("id, sistema, ramo, operacao, url_base, versao, status, atualizado_em")
    .eq("corretora_id", corretoraId)
    .order("atualizado_em", { ascending: false });
  if (error) throw error;
  return (data as ContratoRow[]) ?? [];
}

export async function obterContrato(corretoraId: string, id: string, deps?: PersistDeps): Promise<ContratoRow | null> {
  const sb = cliente(deps);
  const { data, error } = await sb.from("pagina_contrato").select("*").eq("corretora_id", corretoraId).eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as ContratoRow | null) ?? null;
}

/** rascunho → aprovado (idempotente). Só a própria corretora. */
export async function aprovarContrato(corretoraId: string, id: string, porEmail: string | null, deps?: PersistDeps): Promise<void> {
  const sb = cliente(deps);
  const { error } = await sb
    .from("pagina_contrato")
    .update({ status: "aprovado", aprovado_por: porEmail, aprovado_em: new Date().toISOString(), atualizado_em: new Date().toISOString() })
    .eq("corretora_id", corretoraId)
    .eq("id", id);
  if (error) throw error;
}

// ── Adapter spec ───────────────────────────────────────────────────────────

export async function salvarAdapter(corretoraId: string, contratoId: string, spec: AdapterSpec, deps?: PersistDeps): Promise<{ adapterId: string }> {
  const sb = cliente(deps);
  const { data, error } = await sb
    .from("adapter_spec")
    .insert({
      corretora_id: corretoraId,
      contrato_id: contratoId,
      sistema: spec.sistema,
      ramo: spec.ramo,
      operacao: spec.operacao,
      spec,
      versao: spec.versao,
      ativo: false,
      status: "rascunho",
    })
    .select("id")
    .single();
  if (error) throw error;
  return { adapterId: (data as { id: string }).id };
}

export interface AdapterRow {
  id: string;
  contrato_id: string;
  sistema: string;
  ramo: string;
  operacao: string;
  spec: AdapterSpec;
  versao: number;
  ativo: boolean;
  status: string;
}

export async function listarAdapters(corretoraId: string, contratoId: string, deps?: PersistDeps): Promise<AdapterRow[]> {
  const sb = cliente(deps);
  const { data, error } = await sb.from("adapter_spec").select("*").eq("corretora_id", corretoraId).eq("contrato_id", contratoId);
  if (error) throw error;
  return (data as AdapterRow[]) ?? [];
}

/**
 * Ativa UM adapter e desativa os concorrentes da mesma chave
 * (corretora,sistema,ramo,operacao). Exige contrato aprovado (gate de segurança).
 * Invalida o cache do runtime para refletir imediatamente.
 */
export async function ativarAdapter(corretoraId: string, adapterId: string, deps?: PersistDeps): Promise<void> {
  const sb = cliente(deps);
  const { data: row, error: e1 } = await sb
    .from("adapter_spec")
    .select("id, contrato_id, sistema, ramo, operacao")
    .eq("corretora_id", corretoraId)
    .eq("id", adapterId)
    .maybeSingle();
  if (e1) throw e1;
  if (!row) throw new Error("adapter_nao_encontrado");
  const r = row as { contrato_id: string; sistema: string; ramo: string; operacao: string };

  const { data: contrato, error: e2 } = await sb
    .from("pagina_contrato")
    .select("status")
    .eq("corretora_id", corretoraId)
    .eq("id", r.contrato_id)
    .maybeSingle();
  if (e2) throw e2;
  if ((contrato as { status?: string } | null)?.status !== "aprovado") throw new Error("contrato_nao_aprovado");

  // desativa concorrentes (mesma chave) e ativa o escolhido
  const { error: e3 } = await sb
    .from("adapter_spec")
    .update({ ativo: false, atualizado_em: new Date().toISOString() })
    .eq("corretora_id", corretoraId)
    .eq("sistema", r.sistema)
    .eq("ramo", r.ramo)
    .eq("operacao", r.operacao);
  if (e3) throw e3;
  const { error: e4 } = await sb
    .from("adapter_spec")
    .update({ ativo: true, status: "aprovado", atualizado_em: new Date().toISOString() })
    .eq("corretora_id", corretoraId)
    .eq("id", adapterId);
  if (e4) throw e4;
  _resetDescobertaCache();
}

// ── Toggle de execução por corretora ───────────────────────────────────────

export async function lerExecAtivo(corretoraId: string, deps?: PersistDeps): Promise<boolean> {
  const sb = cliente(deps);
  const { data } = await sb.from("descoberta_config").select("exec_ativo").eq("corretora_id", corretoraId).maybeSingle();
  return (data as { exec_ativo?: boolean } | null)?.exec_ativo ?? false;
}

export async function definirExecAtivo(corretoraId: string, ativo: boolean, porEmail: string | null, deps?: PersistDeps): Promise<void> {
  const sb = cliente(deps);
  const { error } = await sb
    .from("descoberta_config")
    .upsert({ corretora_id: corretoraId, exec_ativo: ativo, atualizado_por: porEmail, atualizado_em: new Date().toISOString() }, { onConflict: "corretora_id" });
  if (error) throw error;
  _resetDescobertaCache();
}

// ── Execução / job (observabilidade + fila do daemon) ──────────────────────

export interface JobDescoberta {
  id: string;
  corretora_id: string;
  sistema: string;
  ramo: string | null;
  status: string;
  resumo: { url?: string; operacao?: Operacao; ramosSuportados?: string[] } | null;
}

export async function criarJobDescoberta(
  corretoraId: string,
  sistema: string,
  ramo: string | null,
  pedido: { url?: string; operacao?: Operacao; ramosSuportados?: string[] },
  deps?: PersistDeps,
): Promise<{ jobId: string }> {
  const sb = cliente(deps);
  const { data, error } = await sb
    .from("descoberta_execucao")
    .insert({ corretora_id: corretoraId, sistema, ramo, tipo: "descoberta", status: "andamento", etapa: "fila", resumo: pedido })
    .select("id")
    .single();
  if (error) throw error;
  return { jobId: (data as { id: string }).id };
}

/** Próximo job pendente (daemon). Sem escopo de corretora: o token é a defesa. */
export async function proximoJobDescoberta(deps?: PersistDeps): Promise<JobDescoberta | null> {
  const sb = cliente(deps);
  const { data, error } = await sb
    .from("descoberta_execucao")
    .select("id, corretora_id, sistema, ramo, status, resumo")
    .eq("tipo", "descoberta")
    .eq("status", "andamento")
    .eq("etapa", "fila")
    .order("criado_em", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as JobDescoberta | null) ?? null;
}

// ── Produtor v2: job de construção + gravar adapter VALIDADO por seguradora ──

export interface JobConstrucao {
  id: string;
  corretora_id: string;
  sistema: string;
  ramo: string | null;
  status: string;
  resumo: { seguradoraConfigId?: string; objetivo?: Operacao | string; url?: string; casoTeste?: unknown } | null;
}

/** Job de construção EM VOO (andamento) para a chave, se houver. */
export async function buscarConstrucaoEmVoo(
  corretoraId: string,
  seguradoraConfigId: string,
  ramo: string,
  objetivo: string,
  deps?: PersistDeps,
): Promise<{ id: string } | null> {
  const sb = cliente(deps);
  const { data } = await sb
    .from("descoberta_execucao")
    .select("id")
    .eq("corretora_id", corretoraId)
    .eq("seguradora_config_id", seguradoraConfigId)
    .eq("ramo", ramo)
    .eq("objetivo", objetivo)
    .eq("tipo", "construcao")
    .eq("status", "andamento")
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null) ?? null;
}

/**
 * Cria job de construção. IDEMPOTENTE: se já houver um EM VOO para a mesma chave
 * (corretora,seguradora,ramo,objetivo), REUSA (não duplica — espelha
 * apolice-job.enfileirar). Defesa em profundidade: índice parcial único (cláusula J)
 * + tratamento de 23505 → devolve o existente.
 */
export async function criarJobConstrucao(
  corretoraId: string,
  input: { seguradoraConfigId: string; sistema: string; ramo: string; objetivo: string; url?: string | null; casoTeste?: unknown },
  deps?: PersistDeps,
): Promise<{ jobId: string; jaEmVoo: boolean }> {
  const sb = cliente(deps);
  const emVoo = await buscarConstrucaoEmVoo(corretoraId, input.seguradoraConfigId, input.ramo, input.objetivo, deps);
  if (emVoo) return { jobId: emVoo.id, jaEmVoo: true };

  const { data, error } = await sb
    .from("descoberta_execucao")
    .insert({
      corretora_id: corretoraId,
      seguradora_config_id: input.seguradoraConfigId,
      objetivo: input.objetivo,
      sistema: input.sistema,
      ramo: input.ramo,
      tipo: "construcao",
      status: "andamento",
      etapa: "fila",
      resumo: { seguradoraConfigId: input.seguradoraConfigId, objetivo: input.objetivo, url: input.url ?? null, casoTeste: input.casoTeste ?? null },
    })
    .select("id")
    .single();
  if (error) {
    // corrida: índice único disparou → devolve o em-voo existente
    if ((error as { code?: string }).code === "23505") {
      const ex = await buscarConstrucaoEmVoo(corretoraId, input.seguradoraConfigId, input.ramo, input.objetivo, deps);
      if (ex) return { jobId: ex.id, jaEmVoo: true };
    }
    throw error;
  }
  return { jobId: (data as { id: string }).id, jaEmVoo: false };
}

/** Existe adapter VALIDADO+ativo p/ a chave? (para perguntar "reprocessar?"). */
export async function existeAdapterValidado(
  corretoraId: string,
  seguradoraConfigId: string,
  ramo: string,
  objetivo: string,
  deps?: PersistDeps,
): Promise<boolean> {
  const sb = cliente(deps);
  const { data } = await sb
    .from("adapter_spec")
    .select("id")
    .eq("corretora_id", corretoraId)
    .eq("seguradora_config_id", seguradoraConfigId)
    .eq("ramo", ramo)
    .eq("objetivo", objetivo)
    .eq("ativo", true)
    .eq("status", "validado")
    .limit(1)
    .maybeSingle();
  return Boolean(data);
}

/** Cancela um job EM ANDAMENTO (fila ou em execução). Idempotente. */
export async function cancelarJob(corretoraId: string, jobId: string, deps?: PersistDeps): Promise<void> {
  const sb = cliente(deps);
  const { error } = await sb
    .from("descoberta_execucao")
    .update({ status: "cancelado", etapa: "cancelado" })
    .eq("corretora_id", corretoraId)
    .eq("id", jobId)
    .eq("status", "andamento");
  if (error) throw error;
}

/** Status atual de um job (daemon checa cancelamento). */
export async function lerStatusJob(jobId: string, deps?: PersistDeps): Promise<string | null> {
  const sb = cliente(deps);
  const { data } = await sb.from("descoberta_execucao").select("status").eq("id", jobId).maybeSingle();
  return (data as { status?: string } | null)?.status ?? null;
}

/**
 * Salva o CÓDIGO DE SCRAPING como RASCUNHO (status 'em_construcao', inativo) quando
 * o build NÃO atingiu o objetivo — não perde o trabalho (seletores resolvidos) e
 * o operador pode inspecionar/editar. NÃO desativa o adapter validado vigente.
 */
export async function salvarAdapterRascunho(
  corretoraId: string,
  input: { seguradoraConfigId: string; sistema: string; ramo: string; objetivo: string; spec: AdapterSpec; casoTeste?: unknown; url?: string | null },
  deps?: PersistDeps,
): Promise<{ contratoId: string; adapterId: string; versao: number }> {
  const sb = cliente(deps);
  const versao = await proximaVersaoSeguradora(sb, corretoraId, input.seguradoraConfigId, input.ramo, input.objetivo);
  const { data: ct, error: e1 } = await sb
    .from("pagina_contrato")
    .insert({
      corretora_id: corretoraId,
      seguradora_config_id: input.seguradoraConfigId,
      sistema: input.sistema,
      ramo: input.ramo,
      operacao: input.objetivo,
      objetivo: input.objetivo,
      url_base: input.url ?? null,
      versao,
      status: "rascunho",
    })
    .select("id")
    .single();
  if (e1) throw e1;
  const contratoId = (ct as { id: string }).id;
  const { data: ad, error: e2 } = await sb
    .from("adapter_spec")
    .insert({
      corretora_id: corretoraId,
      contrato_id: contratoId,
      seguradora_config_id: input.seguradoraConfigId,
      sistema: input.sistema,
      ramo: input.ramo,
      operacao: input.objetivo,
      objetivo: input.objetivo,
      spec: input.spec,
      caso_teste: input.casoTeste ?? null,
      versao,
      ativo: false,
      status: "em_construcao",
    })
    .select("id")
    .single();
  if (e2) throw e2;
  return { contratoId, adapterId: (ad as { id: string }).id, versao };
}

/** Próximo job de CONSTRUÇÃO pendente (daemon). Token é a defesa. */
export async function proximoJobConstrucao(deps?: PersistDeps): Promise<JobConstrucao | null> {
  const sb = cliente(deps);
  const { data, error } = await sb
    .from("descoberta_execucao")
    .select("id, corretora_id, sistema, ramo, status, resumo")
    .eq("tipo", "construcao")
    .eq("status", "andamento")
    .eq("etapa", "fila")
    .order("criado_em", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as JobConstrucao | null) ?? null;
}

async function proximaVersaoSeguradora(sb: Sb, corretoraId: string, seguradoraConfigId: string, ramo: string, objetivo: string): Promise<number> {
  const { data } = await sb
    .from("adapter_spec")
    .select("versao")
    .eq("corretora_id", corretoraId)
    .eq("seguradora_config_id", seguradoraConfigId)
    .eq("ramo", ramo)
    .eq("objetivo", objetivo)
    .order("versao", { ascending: false })
    .limit(1)
    .maybeSingle();
  return ((data as { versao?: number } | null)?.versao ?? 0) + 1;
}

/**
 * Grava um adapter VALIDADO (objetivo atingido no ambiente de teste): cria um
 * contrato (aprovado) + o adapter `status='validado'`, ATIVA-o e desativa os
 * concorrentes (mesma seguradora/ramo/objetivo). Chaveado por `seguradora_config_id`
 * (coerência entre módulos). Invalida o cache do runtime.
 */
export async function salvarAdapterValidado(
  corretoraId: string,
  input: {
    seguradoraConfigId: string;
    sistema: string;
    ramo: string;
    objetivo: string;
    spec: AdapterSpec;
    casoTeste?: unknown;
    criterioSucesso?: unknown;
    url?: string | null;
  },
  deps?: PersistDeps,
): Promise<{ contratoId: string; adapterId: string; versao: number }> {
  const sb = cliente(deps);
  const versao = await proximaVersaoSeguradora(sb, corretoraId, input.seguradoraConfigId, input.ramo, input.objetivo);

  // 1) contrato (aprovado) ligado à seguradora + objetivo
  const { data: ct, error: e1 } = await sb
    .from("pagina_contrato")
    .insert({
      corretora_id: corretoraId,
      seguradora_config_id: input.seguradoraConfigId,
      sistema: input.sistema,
      ramo: input.ramo,
      operacao: input.objetivo,
      objetivo: input.objetivo,
      url_base: input.url ?? null,
      versao,
      status: "aprovado",
      aprovado_em: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (e1) throw e1;
  const contratoId = (ct as { id: string }).id;

  // 2) desativa concorrentes (mesma chave) antes de ativar o novo
  const { error: e2 } = await sb
    .from("adapter_spec")
    .update({ ativo: false, atualizado_em: new Date().toISOString() })
    .eq("corretora_id", corretoraId)
    .eq("seguradora_config_id", input.seguradoraConfigId)
    .eq("ramo", input.ramo)
    .eq("objetivo", input.objetivo);
  if (e2) throw e2;

  // 3) insere o adapter validado + ativo
  const { data: ad, error: e3 } = await sb
    .from("adapter_spec")
    .insert({
      corretora_id: corretoraId,
      contrato_id: contratoId,
      seguradora_config_id: input.seguradoraConfigId,
      sistema: input.sistema,
      ramo: input.ramo,
      operacao: input.objetivo,
      objetivo: input.objetivo,
      spec: input.spec,
      caso_teste: input.casoTeste ?? null,
      criterio_sucesso: input.criterioSucesso ?? null,
      versao,
      ativo: true,
      status: "validado",
    })
    .select("id")
    .single();
  if (e3) throw e3;
  _resetDescobertaCache();
  return { contratoId, adapterId: (ad as { id: string }).id, versao };
}

/** Adapters de uma seguradora (board por id). */
export async function listarAdaptersDaSeguradora(corretoraId: string, seguradoraConfigId: string, deps?: PersistDeps): Promise<AdapterRow[]> {
  const sb = cliente(deps);
  const { data, error } = await sb.from("adapter_spec").select("*").eq("corretora_id", corretoraId).eq("seguradora_config_id", seguradoraConfigId);
  if (error) throw error;
  return (data as AdapterRow[]) ?? [];
}

/** Execuções recentes (monitoramento de construção/extração) da corretora. */
export interface ExecucaoRow {
  id: string;
  sistema: string;
  ramo: string | null;
  tipo: string;
  status: string;
  etapa: string | null;
  erro: string | null;
  custo_tokens: number | null;
  resumo: { seguradoraConfigId?: string; objetivo?: string; adapterId?: string } | null;
  criado_em: string;
}

export async function listarExecucoes(corretoraId: string, limite = 25, deps?: PersistDeps): Promise<ExecucaoRow[]> {
  const sb = cliente(deps);
  const { data, error } = await sb
    .from("descoberta_execucao")
    .select("id, sistema, ramo, tipo, status, etapa, erro, custo_tokens, resumo, criado_em")
    .eq("corretora_id", corretoraId)
    .order("criado_em", { ascending: false })
    .limit(limite);
  if (error) throw error;
  return (data as ExecucaoRow[]) ?? [];
}

/** Atualiza só a ETAPA (marcador de evolução em tempo real; status segue 'andamento'). */
export async function atualizarProgressoJob(jobId: string, etapa: string, deps?: PersistDeps): Promise<void> {
  const sb = cliente(deps);
  const { error } = await sb.from("descoberta_execucao").update({ etapa }).eq("id", jobId);
  if (error) logger.warn("[descoberta] atualizarProgressoJob falhou", { erro: (error as Error).message });
}

export async function finalizarJob(
  jobId: string,
  patch: { status: string; etapa?: string; contratoId?: string | null; harRef?: string | null; custoTokens?: number | null; erro?: string | null; resumo?: unknown },
  deps?: PersistDeps,
): Promise<void> {
  const sb = cliente(deps);
  const update: Record<string, unknown> = { status: patch.status };
  if (patch.etapa !== undefined) update.etapa = patch.etapa;
  if (patch.contratoId !== undefined) update.contrato_id = patch.contratoId;
  if (patch.harRef !== undefined) update.har_ref = patch.harRef;
  if (patch.custoTokens !== undefined) update.custo_tokens = patch.custoTokens;
  if (patch.erro !== undefined) update.erro = patch.erro;
  if (patch.resumo !== undefined) update.resumo = patch.resumo;
  const { error } = await sb.from("descoberta_execucao").update(update).eq("id", jobId);
  if (error) logger.warn("[descoberta] finalizarJob falhou", { erro: (error as Error).message });
}
