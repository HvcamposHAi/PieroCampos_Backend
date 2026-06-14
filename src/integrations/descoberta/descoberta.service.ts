/**
 * Serviço de runtime da DESCOBERTA — ponte gated entre o registry e o adapter
 * gerado. ÚNICO ponto que o caminho-quente toca, e SEMPRE FAIL-CLOSED:
 *  - se `DESCOBERTA_EXEC_ENABLED` (env) = false → retorna null SEM tocar o DB;
 *  - se o toggle `descoberta_config.exec_ativo` da corretora = false → null;
 *  - qualquer erro de leitura/forma → null (caller segue no provider legado).
 *
 * Cache curto (30s) por (corretora,sistema,ramo) espelha rule-cache/lerAprendizado.
 * As tabelas novas ainda não estão em types.ts → casts `as never` (padrão do repo).
 */
import axios from "axios";
import { getEnv } from "../../config/env";
import { getSupabaseAdmin } from "../whatsapp/supabase";
import { logger } from "../../utils/logger";
import type { QuoteProvider } from "../quote/quote-provider.port";
import type { AdapterSpec } from "./descoberta.types";
import { criarAdapterProvider, validarSpec, type HttpFn } from "./runtime/adapter-runner";
import { CircuitBreaker } from "./runtime/resiliencia";

const TTL_MS = 30_000;
const _cache = new Map<string, { provider: QuoteProvider | null; em: number }>();
/** Um circuit breaker compartilhado entre chamadas (estado por corretora:sistema). */
const _circuit = new CircuitBreaker();

/** HTTP real (axios) injetado no runner. `validateStatus` deixa o runner decidir. */
const httpAxios: HttpFn = async (req) => {
  const r = await axios.request({
    method: req.metodo,
    url: req.url,
    headers: req.headers,
    data: req.corpo,
    timeout: 30_000,
    validateStatus: () => true,
  });
  return { status: r.status, corpo: r.data };
};

function chave(corretoraId: string | undefined, sistema: string, ramo: string): string {
  return `${corretoraId ?? "seed"}:${sistema}:${ramo}`;
}

/**
 * Provider do ADAPTER ATIVO para (corretora, sistema, ramo), ou null.
 * Gated + FAIL-CLOSED. Chamado por `resolveProvider` ANTES do fallback legado.
 */
export async function lerAdapterAtivoProvider(
  corretoraId: string | undefined,
  sistema: string,
  ramo: string,
): Promise<QuoteProvider | null> {
  let execLigado = false;
  try {
    execLigado = getEnv().DESCOBERTA_EXEC_ENABLED;
  } catch {
    return null; // env inválida em teste/boot → comportamento legado
  }
  if (!execLigado) return null;

  const ck = chave(corretoraId, sistema, ramo);
  const cached = _cache.get(ck);
  if (cached && Date.now() - cached.em < TTL_MS) return cached.provider;

  let provider: QuoteProvider | null = null;
  try {
    if (!corretoraId) return null;
    const sb = getSupabaseAdmin();
    // toggle por corretora (FAIL-CLOSED: ausente/false → não executa)
    const { data: cfg } = await sb
      .from("descoberta_config")
      .select("exec_ativo")
      .eq("corretora_id", corretoraId)
      .maybeSingle();
    const ativo = (cfg as { exec_ativo?: boolean } | null)?.exec_ativo ?? false;
    if (!ativo) {
      _cache.set(ck, { provider: null, em: Date.now() });
      return null;
    }

    const { data, error } = await sb
      .from("adapter_spec")
      .select("spec")
      .eq("sistema", sistema)
      .eq("ramo", ramo)
      .eq("operacao", "cotacao")
      .eq("ativo", true)
      .eq("corretora_id", corretoraId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const spec = (data as { spec?: AdapterSpec } | null)?.spec ?? null;
    if (spec && validarSpec(spec).ok) {
      provider = criarAdapterProvider(spec, { http: httpAxios, circuit: _circuit });
    }
  } catch (e) {
    logger.warn("[descoberta] lerAdapterAtivoProvider falhou (FAIL-CLOSED → legado)", {
      erro: e instanceof Error ? e.message : String(e),
    });
    provider = null;
  }

  _cache.set(ck, { provider, em: Date.now() });
  return provider;
}

/** Limpa o cache (uso em testes). */
export function _resetDescobertaCache(): void {
  _cache.clear();
}
