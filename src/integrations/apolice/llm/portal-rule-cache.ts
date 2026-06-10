/**
 * Cache + escrita das REGRAS de seletor de portal (tabela portal_selector_rule).
 * Espelha quote/mapper/rule-cache: leitura só de regras `ativo` (cache 30s por
 * seguradora+corretora); escrita como `pendente` (aprovação humana antes de valer).
 * Erro → Map vazio (o resolver cai no hint tolerante; nunca lança).
 */
import { getSupabaseAdmin } from "../../whatsapp/supabase";
import { logger } from "../../../utils/logger";

const TTL_MS = 30_000;

interface RuleRow {
  corretora_id: string | null;
  seguradora: string;
  acao: string;
  seletor_resolvido: string;
}

/** Map<acao, seletor>. */
const _cache = new Map<string, { mapa: Map<string, string>; em: number }>();

function cacheKey(seguradora: string, corretoraId: string | null): string {
  return `${seguradora.toLowerCase()}:${corretoraId ?? "_default_"}`;
}

/** Regras ATIVAS por seguradora (default global + override da corretora vence). */
export async function carregarRegrasPortal(
  seguradora: string,
  corretoraId: string | null,
): Promise<Map<string, string>> {
  const ck = cacheKey(seguradora, corretoraId);
  const agora = Date.now();
  const cached = _cache.get(ck);
  if (cached && agora - cached.em < TTL_MS) return cached.mapa;
  try {
    const sb = getSupabaseAdmin();
    let q = sb
      .from("portal_selector_rule")
      .select("corretora_id, seguradora, acao, seletor_resolvido")
      .ilike("seguradora", seguradora)
      .eq("status", "ativo");
    q = corretoraId
      ? q.or(`corretora_id.is.null,corretora_id.eq.${corretoraId}`)
      : q.is("corretora_id", null);
    const { data, error } = await q;
    if (error) {
      logger.warn("[portal.rules] leitura falhou; sem regras ativas", { erro: error.message });
      return new Map();
    }
    const linhas = (data ?? []) as RuleRow[];
    const mapa = new Map<string, string>();
    for (const l of linhas.filter((x) => x.corretora_id === null)) mapa.set(l.acao, l.seletor_resolvido);
    for (const l of linhas.filter((x) => x.corretora_id !== null)) mapa.set(l.acao, l.seletor_resolvido);
    _cache.set(ck, { mapa, em: agora });
    return mapa;
  } catch (e) {
    logger.warn("[portal.rules] exceção na leitura; sem regras ativas", { erro: (e as Error).message });
    return new Map();
  }
}

/** Grava regra resolvida pelo LLM como `pendente` (revisão humana). Idempotente. */
export async function persistirRegraPortalPendente(input: {
  seguradora: string;
  acao: string;
  seletor: string;
  corretoraId: string | null;
  confianca: number;
}): Promise<void> {
  try {
    const sb = getSupabaseAdmin();
    let dup = sb
      .from("portal_selector_rule")
      .select("id")
      .ilike("seguradora", input.seguradora)
      .eq("acao", input.acao);
    dup = input.corretoraId
      ? dup.eq("corretora_id" as never, input.corretoraId as never)
      : dup.is("corretora_id", null);
    const { data: existente } = await dup.maybeSingle();
    if (existente) return;
    const { error } = await sb.from("portal_selector_rule").insert({
      corretora_id: input.corretoraId,
      seguradora: input.seguradora,
      acao: input.acao,
      seletor_resolvido: input.seletor,
      origem: "llm",
      status: "pendente",
      confianca: input.confianca,
    } as never);
    if (error) logger.warn("[portal.rules] falha gravando regra pendente", { erro: error.message });
  } catch (e) {
    logger.warn("[portal.rules] exceção gravando regra pendente", { erro: (e as Error).message });
  }
}

/** Apenas para testes: zera o cache. */
export function _resetPortalRuleCache(): void {
  _cache.clear();
}
