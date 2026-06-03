/**
 * Curadoria das seguradoras a cotar (Admin > Segfy). A lista completa vem da
 * conta Segfy (vehicleCompanyList); o operador marca quais cotar (`ativa`). A
 * cotação usa SÓ as ativas; se a tabela estiver vazia, o multicálculo cai no
 * fallback (INSURERS_PADRAO) — nunca deixa de cotar por falta de curadoria.
 *
 * A leitura do Supabase vive AQUI (camada de serviço); o módulo isolado
 * `src/integrations/segfy/*` segue sem conhecer Supabase.
 */
import { getSupabaseAdmin } from "../integrations/whatsapp/supabase";
import { listarSeguradorasSegfy } from "../integrations/segfy/segfy.multicalculo";
import { obterCredenciaisSegfy } from "./segfy-credenciais.service";
import { logger } from "../utils/logger";

export interface SeguradoraConfig {
  codigo: string;
  nome: string;
  comissao: number;
  ativa: boolean;
  atualizado_em: string | null;
}

/** Seguradoras ATIVAS no formato esperado por `cotarAuto` (config.insurers). */
export async function listarSeguradorasAtivas(): Promise<Array<{ name: string; commission: number }>> {
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("segfy_seguradoras")
      .select("codigo, comissao")
      .eq("ativa", true);
    if (error || !data) return [];
    return (data as Array<{ codigo: string; comissao: number }>).map((r) => ({
      name: r.codigo,
      commission: Number(r.comissao) || 15,
    }));
  } catch (e) {
    logger.warn("[segfy.seg] leitura de ativas falhou; fallback no multicálculo", {
      erro: (e as Error).message,
    });
    return [];
  }
}

/** Lista completa para a tela do Admin (ativas e inativas). */
export async function listarSeguradorasConfig(): Promise<SeguradoraConfig[]> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("segfy_seguradoras")
    .select("codigo, nome, comissao, ativa, atualizado_em")
    .order("nome", { ascending: true });
  if (error) throw new Error(`listarSeguradorasConfig: ${error.message}`);
  return (data ?? []) as SeguradoraConfig[];
}

/**
 * Sincroniza a lista com a conta Segfy (upsert por `codigo`). PRESERVA a
 * curadoria do operador: o upsert NÃO toca em `ativa` (omitida do payload), então
 * linhas existentes mantêm o estado e linhas novas nascem ativas (default do banco).
 */
export async function sincronizarSeguradoras(): Promise<{ total: number; sincronizadas: number }> {
  const creds = await obterCredenciaisSegfy();
  if (!creds) throw new Error("sem_credenciais");
  const lista = await listarSeguradorasSegfy({ email: creds.email, password: creds.password });
  if (lista.length === 0) {
    return { total: 0, sincronizadas: 0 };
  }
  const sb = getSupabaseAdmin();
  const agora = new Date().toISOString();
  const payload = lista.map((s) => ({
    codigo: s.codigo,
    nome: s.nome,
    comissao: s.comissao,
    atualizado_em: agora,
  }));
  const { error } = await sb.from("segfy_seguradoras").upsert(payload, { onConflict: "codigo" });
  if (error) throw new Error(`sincronizarSeguradoras: ${error.message}`);
  logger.info("[segfy.seg] seguradoras sincronizadas", { total: lista.length });
  return { total: lista.length, sincronizadas: payload.length };
}

/** Liga/desliga ou ajusta a comissão de uma seguradora. */
export async function atualizarSeguradora(
  codigo: string,
  patch: { ativa?: boolean; comissao?: number },
): Promise<void> {
  const sb = getSupabaseAdmin();
  const update: Record<string, unknown> = { atualizado_em: new Date().toISOString() };
  if (typeof patch.ativa === "boolean") update.ativa = patch.ativa;
  if (typeof patch.comissao === "number" && Number.isFinite(patch.comissao)) update.comissao = patch.comissao;
  const { error } = await sb.from("segfy_seguradoras").update(update).eq("codigo", codigo);
  if (error) throw new Error(`atualizarSeguradora: ${error.message}`);
}
