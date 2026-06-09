/**
 * Porta pública do mapeamento dinâmico + toggle por corretora.
 *
 * `resolverEntrada` é o ÚNICO ponto chamado pelo segfy-cotacao.service. Decide
 * dinâmico × hardcoded e faz FALLBACK em QUALQUER falha — SEMPRE devolve um
 * EntradaMapeada. O fallback é INJETADO (mapearParaCotacao), evitando ciclo de
 * import com o service.
 *
 * FAIL-CLOSED ("fechado" = comportamento hardcoded de hoje): env master off,
 * toggle off/erro, schema ausente/erro, ou QUALQUER exceção → fallback.
 */
import { getEnv } from "../../../config/env";
import { getSupabaseAdmin } from "../../whatsapp/supabase";
import { logger } from "../../../utils/logger";
import { obterSchemaEfetivo } from "./schema-store";
import { mapearDinamico, type MapearDinamicoDeps } from "./dynamic-mapper";
import type { EntradaMapeada } from "./legacy";

export interface ResolverCtx {
  provider: string;
  ramo: string;
  corretoraId?: string;
}

type Fallback = (dados: Record<string, unknown>, cliente: { cpf: string | null; nome?: string | null }) => EntradaMapeada;

export async function resolverEntrada(
  dados: Record<string, unknown>,
  cliente: { cpf: string | null; nome?: string | null },
  ctx: ResolverCtx,
  fallback: Fallback,
  deps?: MapearDinamicoDeps,
): Promise<EntradaMapeada> {
  try {
    if (!getEnv().MAPPER_DINAMICO_ENABLED) return fallback(dados, cliente);
    const corretoraId = ctx.corretoraId ?? null;
    const ativo = await lerMapperDinamicoAtivo(corretoraId);
    if (!ativo) return fallback(dados, cliente);
    const schema = await obterSchemaEfetivo(ctx.provider, ctx.ramo, corretoraId);
    if (!schema) return fallback(dados, cliente);
    return await mapearDinamico(dados, cliente, { ...ctx, corretoraId, schema }, deps);
  } catch (e) {
    logger.warn("[mapper] dinâmico falhou; fallback hardcoded", { erro: (e as Error).message });
    return fallback(dados, cliente);
  }
}

// ----------------------------------------------------------------------------
// Toggle por corretora (default global corretora_id IS NULL + override)
// ----------------------------------------------------------------------------
const TTL_MS = 30_000;
const _cache = new Map<string, { valor: boolean; em: number }>();

function ck(corretoraId: string | null): string {
  return corretoraId ?? "_default_";
}

/** Liga/desliga efetivo (override da corretora vence o default). FAIL-CLOSED off. */
export async function lerMapperDinamicoAtivo(corretoraId: string | null): Promise<boolean> {
  const agora = Date.now();
  const cached = _cache.get(ck(corretoraId));
  if (cached && agora - cached.em < TTL_MS) return cached.valor;
  try {
    const sb = getSupabaseAdmin();
    let q = sb.from("quote_mapper_config").select("corretora_id, ativo");
    q = corretoraId
      ? q.or(`corretora_id.is.null,corretora_id.eq.${corretoraId}`)
      : q.is("corretora_id", null);
    const { data, error } = await q;
    if (error) {
      logger.warn("[mapper] leitura do toggle falhou; fail-closed (off)", { erro: error.message });
      return false; // não cacheia erro
    }
    const linhas = (data ?? []) as Array<{ corretora_id: string | null; ativo: boolean }>;
    const override = corretoraId ? linhas.find((l) => l.corretora_id === corretoraId) : undefined;
    const padrao = linhas.find((l) => l.corretora_id === null);
    const v = (override ?? padrao)?.ativo === true;
    _cache.set(ck(corretoraId), { valor: v, em: agora });
    return v;
  } catch (e) {
    logger.warn("[mapper] exceção lendo toggle; fail-closed (off)", { erro: (e as Error).message });
    return false;
  }
}

/** Liga/desliga o toggle (default quando corretoraId null, senão override da corretora). */
export async function definirMapperDinamicoAtivo(
  corretoraId: string | null,
  ativo: boolean,
  porEmail: string | null,
): Promise<void> {
  const sb = getSupabaseAdmin();
  let sel = sb.from("quote_mapper_config").select("corretora_id");
  sel = corretoraId ? sel.eq("corretora_id" as never, corretoraId as never) : sel.is("corretora_id", null);
  const { data: existente, error: selErr } = await sel.maybeSingle();
  if (selErr) throw new Error(`definirMapperDinamicoAtivo(select): ${selErr.message}`);

  const payload = {
    corretora_id: corretoraId,
    ativo,
    atualizado_em: new Date().toISOString(),
    atualizado_por: porEmail,
  };
  if (existente) {
    let upd = sb.from("quote_mapper_config").update(payload as never);
    upd = corretoraId ? upd.eq("corretora_id" as never, corretoraId as never) : upd.is("corretora_id", null);
    const { error } = await upd;
    if (error) throw new Error(`definirMapperDinamicoAtivo(update): ${error.message}`);
  } else {
    const { error } = await sb.from("quote_mapper_config").insert(payload as never);
    if (error) throw new Error(`definirMapperDinamicoAtivo(insert): ${error.message}`);
  }
  _cache.set(ck(corretoraId), { valor: ativo, em: Date.now() });
  logger.info("[mapper] toggle alterado", { corretora_id: corretoraId, ativo, por: porEmail });
}

/** Apenas para testes: zera o cache do toggle. */
export function _resetMapperToggleCache(): void {
  _cache.clear();
}
