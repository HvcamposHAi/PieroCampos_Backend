/**
 * Fila de JOBS de apólice (testar conectividade / emitir) executados pelo AGENTE
 * LOCAL — o navegador NÃO roda no Render. Espelha a máquina de estados do Segfy
 * reauth (segfy-reauth-orq), mas MULTI-LINHA (vários testes/emissões), persistida
 * na tabela `apolice_job`. O backend (Render) é só o corretor: enfileira, o agente
 * (token-gated, atrás de NAT → polling) pega/reporta. O código 2FA é transitório
 * (só entre 'codigo_enviado' e o agente aplicar), NUNCA logado, e só o agente lê.
 *
 * Store injetável (`_setJobStore`) p/ teste — em produção usa Supabase (service_role).
 */
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../integrations/whatsapp/supabase";
import { logger } from "../utils/logger";

export type ApoliceJobTipo = "testar" | "emitir";
export type ApoliceJobFase =
  | "solicitada"
  | "abrindo"
  | "aguardando_codigo"
  | "codigo_enviado"
  | "concluida"
  | "erro"
  | "expirada";

export interface ApoliceJob {
  id: string;
  corretora_id: string;
  tipo: ApoliceJobTipo;
  seguradora_config_id: string | null;
  proposta_id: string | null;
  fase: ApoliceJobFase;
  codigo: string | null;
  resultado: Record<string, unknown> | null;
  mensagem: string | null;
  por: string | null;
  criada_em: string;
  atualizada_em: string;
}

/** Janela de vida de um job em fase não-terminal. */
const JOB_TTL_MS = 5 * 60 * 1000;

function terminal(f: ApoliceJobFase): boolean {
  return f === "concluida" || f === "erro" || f === "expirada";
}
function expirado(j: ApoliceJob): boolean {
  return Date.now() - new Date(j.criada_em).getTime() > JOB_TTL_MS;
}

// ── Store (DB-agnóstico p/ teste) ────────────────────────────────────────────
export interface ApoliceJobStore {
  inserir(job: ApoliceJob): Promise<void>;
  buscarPorId(id: string): Promise<ApoliceJob | null>;
  buscarEmVoo(tipo: ApoliceJobTipo, alvo: string, corretoraId: string): Promise<ApoliceJob | null>;
  proximoSolicitado(): Promise<ApoliceJob | null>;
  atualizar(id: string, patch: Partial<ApoliceJob>): Promise<void>;
}

const COLS =
  "id,corretora_id,tipo,seguradora_config_id,proposta_id,fase,codigo,resultado,mensagem,por,criada_em,atualizada_em";

class SupabaseJobStore implements ApoliceJobStore {
  async inserir(job: ApoliceJob): Promise<void> {
    const { error } = await getSupabaseAdmin().from("apolice_job").insert(job as never);
    if (error) throw new Error(`inserir job: ${error.message}`);
  }
  async buscarPorId(id: string): Promise<ApoliceJob | null> {
    const { data } = await getSupabaseAdmin().from("apolice_job").select(COLS).eq("id", id).maybeSingle();
    return (data as ApoliceJob) ?? null;
  }
  async buscarEmVoo(tipo: ApoliceJobTipo, alvo: string, corretoraId: string): Promise<ApoliceJob | null> {
    const coluna = tipo === "testar" ? "seguradora_config_id" : "proposta_id";
    const { data } = await getSupabaseAdmin()
      .from("apolice_job")
      .select(COLS)
      .eq("corretora_id" as never, corretoraId as never)
      .eq("tipo", tipo)
      .eq(coluna as never, alvo as never)
      .not("fase", "in", "(concluida,erro,expirada)")
      .order("criada_em", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data as ApoliceJob) ?? null;
  }
  async proximoSolicitado(): Promise<ApoliceJob | null> {
    const { data } = await getSupabaseAdmin()
      .from("apolice_job")
      .select(COLS)
      .eq("fase", "solicitada")
      .order("criada_em", { ascending: true })
      .limit(1)
      .maybeSingle();
    return (data as ApoliceJob) ?? null;
  }
  async atualizar(id: string, patch: Partial<ApoliceJob>): Promise<void> {
    const { error } = await getSupabaseAdmin().from("apolice_job").update(patch as never).eq("id", id);
    if (error) throw new Error(`atualizar job: ${error.message}`);
  }
}

let store: ApoliceJobStore = new SupabaseJobStore();
/** Injeta um store (teste). */
export function _setJobStore(s: ApoliceJobStore): void {
  store = s;
}

// ── API ──────────────────────────────────────────────────────────────────────

/**
 * Enfileira um job. Idempotente: se já houver um job EM VOO para o mesmo
 * (tipo, alvo, corretora), reusa (evita 2 cliques).
 */
export async function enfileirar(input: {
  tipo: ApoliceJobTipo;
  alvo: string; // seguradora_config_id (testar) ou proposta_id (emitir)
  corretoraId: string;
  por?: string | null;
}): Promise<{ jobId: string; fase: ApoliceJobFase }> {
  const emVoo = await store.buscarEmVoo(input.tipo, input.alvo, input.corretoraId);
  if (emVoo && !terminal(emVoo.fase) && !expirado(emVoo)) {
    return { jobId: emVoo.id, fase: emVoo.fase };
  }
  const agora = new Date().toISOString();
  const job: ApoliceJob = {
    id: randomUUID(),
    corretora_id: input.corretoraId,
    tipo: input.tipo,
    seguradora_config_id: input.tipo === "testar" ? input.alvo : null,
    proposta_id: input.tipo === "emitir" ? input.alvo : null,
    fase: "solicitada",
    codigo: null,
    resultado: null,
    mensagem: null,
    por: input.por ?? null,
    criada_em: agora,
    atualizada_em: agora,
  };
  await store.inserir(job);
  logger.info("[apolice.job] enfileirado", { tipo: input.tipo, por: input.por });
  return { jobId: job.id, fase: job.fase };
}

/** Agente pega o próximo job 'solicitada' (flip → 'abrindo'). Expira o stale antes. */
export async function pegarProximoTrabalho(): Promise<ApoliceJob | null> {
  const job = await store.proximoSolicitado();
  if (!job) return null;
  if (expirado(job)) {
    await store.atualizar(job.id, { fase: "expirada", atualizada_em: new Date().toISOString() });
    return null;
  }
  const novo: Partial<ApoliceJob> = { fase: "abrindo", atualizada_em: new Date().toISOString() };
  await store.atualizar(job.id, novo);
  return { ...job, ...novo } as ApoliceJob;
}

/** Leitura do agente (token-gated): job completo INCLUINDO o código (p/ aplicar o 2FA). */
export async function lerJobAgente(jobId: string): Promise<ApoliceJob | null> {
  const job = await store.buscarPorId(jobId);
  if (!job) return null;
  if (!terminal(job.fase) && expirado(job)) {
    await store.atualizar(job.id, { fase: "expirada", atualizada_em: new Date().toISOString() });
    return { ...job, fase: "expirada" };
  }
  return job;
}

/** Agente reporta progresso/fim. Em fase terminal, limpa o código por segurança. */
export async function agenteReportar(input: {
  jobId: string;
  fase: "aguardando_codigo" | "concluida" | "erro";
  resultado?: Record<string, unknown> | null;
  mensagem?: string | null;
}): Promise<boolean> {
  const job = await store.buscarPorId(input.jobId);
  if (!job) return false;
  await store.atualizar(job.id, {
    fase: input.fase,
    resultado: input.resultado ?? job.resultado ?? null,
    mensagem: input.mensagem ?? null,
    codigo: input.fase === "aguardando_codigo" ? job.codigo ?? null : null,
    atualizada_em: new Date().toISOString(),
  });
  return true;
}

/** Admin envia o código 2FA. Só vale em 'aguardando_codigo'. */
export async function enviarCodigo(input: { jobId: string; codigo: string }): Promise<{ ok: boolean; erro?: string }> {
  const job = await store.buscarPorId(input.jobId);
  if (!job) return { ok: false, erro: "job_invalido" };
  if (expirado(job)) {
    await store.atualizar(job.id, { fase: "expirada", atualizada_em: new Date().toISOString() });
    return { ok: false, erro: "expirado" };
  }
  if (job.fase !== "aguardando_codigo") return { ok: false, erro: "fase_invalida" };
  await store.atualizar(job.id, {
    fase: "codigo_enviado",
    codigo: input.codigo.trim(),
    atualizada_em: new Date().toISOString(),
  });
  return { ok: true };
}

/** Status para a UI (polling). NUNCA devolve o código. */
export async function statusJob(jobId: string): Promise<{ fase: ApoliceJobFase | "idle"; mensagem: string | null }> {
  const job = await store.buscarPorId(jobId);
  if (!job) return { fase: "idle", mensagem: null };
  if (!terminal(job.fase) && expirado(job)) {
    await store.atualizar(job.id, { fase: "expirada", atualizada_em: new Date().toISOString() });
    return { fase: "expirada", mensagem: "O agente não respondeu (offline?). Tente de novo." };
  }
  return { fase: job.fase, mensagem: job.mensagem ?? null };
}
