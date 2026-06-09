/**
 * ORQUESTRAÇÃO da reautenticação 1-clique do Segfy (contorno do 2FA SEM navegador
 * no servidor — solução gratuita). O backend (Render Free) é só o CORRETOR de
 * mensagens entre o app (admin) e o AGENTE LOCAL (máquina do escritório, atrás de
 * NAT → ela faz polling). O navegador e o 2FA acontecem na máquina local; o código
 * é digitado no APP. Máquina de estados de UM job (a sessão Segfy é singleton da
 * conta) persistida em `segfy_credenciais.reauth_job` (sobrevive à hibernação).
 *
 * Fluxo: admin solicita → agente pega (abrindo) → chega no MFA (aguardando_codigo)
 *   → admin digita (codigo_enviado) → agente aplica + colhe tokens (concluida).
 *
 * Segurança: o código 2FA é transitório (some ao concluir), NUNCA é logado, e só o
 * agente (token-gated) o lê. `statusReauth` (UI) jamais devolve o código.
 */
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../integrations/whatsapp/supabase";
import { logger } from "../utils/logger";

const ID_SINGLETON = "singleton";
/** Janela de vida de um job; passou disso em fase não-terminal → 'expirada'. */
const JOB_TTL_MS = 5 * 60 * 1000;

export type ReauthFase =
  | "solicitada"
  | "abrindo"
  | "aguardando_codigo"
  | "codigo_enviado"
  | "concluida"
  | "erro"
  | "expirada";

export interface ReauthJob {
  id: string;
  fase: ReauthFase;
  criada_em: string;
  atualizada_em: string;
  por: string | null;
  /** Código 2FA — transitório (só entre 'codigo_enviado' e o agente aplicar). */
  codigo?: string | null;
  mensagem?: string | null;
  /** E-mail/login do Segfy (p/ a UI: "código enviado para ..."). */
  email?: string | null;
}

function terminal(fase: ReauthFase): boolean {
  return fase === "concluida" || fase === "erro" || fase === "expirada";
}
function expirado(job: ReauthJob): boolean {
  return Date.now() - new Date(job.criada_em).getTime() > JOB_TTL_MS;
}

async function lerJob(): Promise<ReauthJob | null> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("segfy_credenciais")
    .select("reauth_job")
    .eq("id", ID_SINGLETON)
    .maybeSingle();
  if (error || !data) return null;
  return ((data as { reauth_job: ReauthJob | null }).reauth_job) ?? null;
}

async function gravarJob(job: ReauthJob | null): Promise<void> {
  const sb = getSupabaseAdmin();
  await sb.from("segfy_credenciais").update({ reauth_job: job }).eq("id", ID_SINGLETON);
}

/**
 * Admin pede uma reauth. Idempotente: se já houver um job EM VOO (não-terminal e
 * não-expirado), reusa em vez de criar outro (evita corrida de 2 cliques).
 */
export async function solicitarReauth(porEmail: string | null): Promise<{ jobId: string; fase: ReauthFase }> {
  const atual = await lerJob();
  if (atual && !terminal(atual.fase) && !expirado(atual)) {
    return { jobId: atual.id, fase: atual.fase };
  }
  const agora = new Date().toISOString();
  const job: ReauthJob = {
    id: randomUUID(),
    fase: "solicitada",
    criada_em: agora,
    atualizada_em: agora,
    por: porEmail,
    codigo: null,
    mensagem: null,
    email: null,
  };
  await gravarJob(job);
  logger.info("[segfy.reauth] job solicitado", { por: porEmail });
  return { jobId: job.id, fase: job.fase };
}

/**
 * Agente pega o trabalho. Faz o flip 'solicitada'→'abrindo' (assume 1 agente; a
 * sessão é singleton). Em fases posteriores devolve o job como está (inclui o
 * `codigo` quando 'codigo_enviado' — só o agente, token-gated, lê isto). Job
 * expirado → marca 'expirada' e devolve null.
 */
export async function pegarTrabalhoReauth(): Promise<ReauthJob | null> {
  const job = await lerJob();
  if (!job || terminal(job.fase)) return null;
  if (expirado(job)) {
    await gravarJob({ ...job, fase: "expirada", atualizada_em: new Date().toISOString() });
    return null;
  }
  if (job.fase === "solicitada") {
    const novo: ReauthJob = { ...job, fase: "abrindo", atualizada_em: new Date().toISOString() };
    await gravarJob(novo);
    return novo;
  }
  return job;
}

/** Agente reporta progresso/fim. Em fase terminal, limpa o código por segurança. */
export async function agenteReportar(input: {
  jobId: string;
  fase: "aguardando_codigo" | "concluida" | "erro";
  mensagem?: string | null;
  email?: string | null;
}): Promise<boolean> {
  const job = await lerJob();
  if (!job || job.id !== input.jobId) return false;
  const atualizado: ReauthJob = {
    ...job,
    fase: input.fase,
    mensagem: input.mensagem ?? null,
    email: input.email ?? job.email ?? null,
    codigo: input.fase === "aguardando_codigo" ? job.codigo ?? null : null,
    atualizada_em: new Date().toISOString(),
  };
  await gravarJob(atualizado);
  if (input.fase !== "aguardando_codigo") {
    logger.info("[segfy.reauth] job finalizado pelo agente", { fase: input.fase });
  }
  return true;
}

/** Admin envia o código 2FA. Só vale em 'aguardando_codigo'. */
export async function enviarCodigoReauth(input: {
  jobId: string;
  codigo: string;
}): Promise<{ ok: boolean; erro?: string }> {
  const job = await lerJob();
  if (!job || job.id !== input.jobId) return { ok: false, erro: "job_invalido" };
  if (expirado(job)) {
    await gravarJob({ ...job, fase: "expirada", atualizada_em: new Date().toISOString() });
    return { ok: false, erro: "expirado" };
  }
  if (job.fase !== "aguardando_codigo") return { ok: false, erro: "fase_invalida" };
  await gravarJob({ ...job, fase: "codigo_enviado", codigo: input.codigo.trim(), atualizada_em: new Date().toISOString() });
  return { ok: true };
}

/** Status para a UI (polling). NUNCA devolve o código. */
export async function statusReauth(jobId?: string): Promise<{ fase: ReauthFase | "idle"; mensagem: string | null; email: string | null }> {
  const job = await lerJob();
  if (!job || (jobId && job.id !== jobId)) return { fase: "idle", mensagem: null, email: null };
  if (!terminal(job.fase) && expirado(job)) {
    await gravarJob({ ...job, fase: "expirada", atualizada_em: new Date().toISOString() });
    return { fase: "expirada", mensagem: "A reautenticação expirou — tente de novo.", email: job.email ?? null };
  }
  return { fase: job.fase, mensagem: job.mensagem ?? null, email: job.email ?? null };
}
