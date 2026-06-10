/**
 * Produtos (ramos) habilitados POR CORRETORA — gate funcional do setup.
 * Tabela `corretora_ramos` (corretora_id, ramo, ativo). Sem registros para uma
 * corretora ⇒ FAIL-OPEN (todos os ramos) para nunca travar uma corretora por
 * falta de config. Cache de 30s (mesma cadência dos demais toggles).
 */
import { getSupabaseAdmin } from "../integrations/whatsapp/supabase";
import { RAMOS_VALIDOS, type Ramo, normalizarRamo } from "../lib/roteiros";
import { logger } from "../utils/logger";

interface CacheEntry {
  ramos: Set<string>;
  exp: number;
}
const cache = new Map<string, CacheEntry>();
const TTL_MS = 30_000;

/** Conjunto de ramos habilitados da corretora. Vazio no banco ⇒ todos (fail-open). */
export async function lerRamosHabilitados(corretoraId: string): Promise<Set<string>> {
  const agora = Date.now();
  const c = cache.get(corretoraId);
  if (c && c.exp > agora) return c.ramos;
  let ramos: Set<string>;
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("corretora_ramos")
      .select("ramo, ativo")
      .eq("corretora_id" as never, corretoraId as never);
    if (error) throw error;
    const linhas = (data as Array<{ ramo: string; ativo: boolean }> | null) ?? [];
    // Sem nenhuma linha → fail-open (todos os ramos válidos).
    ramos = linhas.length === 0
      ? new Set(RAMOS_VALIDOS)
      : new Set(linhas.filter((l) => l.ativo !== false).map((l) => l.ramo));
  } catch (e) {
    logger.warn("[corretora-ramos] leitura falhou; fail-open (todos)", {
      corretoraId,
      erro: (e as Error).message,
    });
    ramos = new Set(RAMOS_VALIDOS);
  }
  cache.set(corretoraId, { ramos, exp: agora + TTL_MS });
  return ramos;
}

/** true se o ramo está habilitado para a corretora (ou se não há config). */
export async function ramoHabilitado(corretoraId: string, ramo: string | null | undefined): Promise<boolean> {
  const r = normalizarRamo(ramo);
  return (await lerRamosHabilitados(corretoraId)).has(r);
}

/** Salva os ramos habilitados (substitui o conjunto) e invalida o cache. */
export async function salvarRamosHabilitados(corretoraId: string, ramos: Ramo[]): Promise<void> {
  const sb = getSupabaseAdmin();
  const desejados = new Set(ramos.map((r) => normalizarRamo(r)));
  // upsert ativo=true p/ os desejados; ativo=false p/ os demais válidos.
  const linhas = [...RAMOS_VALIDOS].map((ramo) => ({
    corretora_id: corretoraId,
    ramo,
    ativo: desejados.has(ramo),
  }));
  const { error } = await sb
    .from("corretora_ramos")
    .upsert(linhas as never, { onConflict: "corretora_id,ramo" });
  if (error) throw new Error(`salvarRamosHabilitados: ${error.message}`);
  cache.delete(corretoraId);
  logger.info("[corretora-ramos] ramos salvos", { corretoraId, ramos: [...desejados] });
}

/** Reseta o cache (uso em testes / após alteração). */
export function _resetRamosCache(corretoraId?: string): void {
  if (corretoraId) cache.delete(corretoraId);
  else cache.clear();
}
