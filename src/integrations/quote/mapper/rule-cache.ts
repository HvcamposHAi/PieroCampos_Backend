/**
 * Cache + escrita das REGRAS aprendidas (tabela quote_mapping_rule).
 *
 * Leitura (`carregarRegras`): só regras `ativo`, com cache curto (30s) por
 * (provider, ramo, corretora) — espelha lerAprendizadoAtivo. Erro → Map vazio
 * (o mapper degrada para sinônimo/LLM/hardcoded; nunca lança).
 *
 * Escrita (`persistirRegraAprendida`): grava como `pendente` (NÃO ativa); só
 * passa a valer em runtime após aprovação humana no Admin. Idempotente: não
 * duplica se já existe regra (qualquer status) para a mesma chave/entrada.
 */
import { getSupabaseAdmin } from "../../whatsapp/supabase";
import { logger } from "../../../utils/logger";
import type { LearnedRule } from "./learned-rule.types";

const TTL_MS = 30_000;

/** Chave do Map em memória: `${chaveAlvo}::${entradaNormalizada}`. */
export function chaveRegra(chaveAlvo: string, entradaNormalizada: string): string {
  return `${chaveAlvo}::${entradaNormalizada}`;
}

interface RuleRow {
  corretora_id: string | null;
  chave_alvo: string;
  entrada_normalizada: string;
  valor_resolvido: string;
  origem: LearnedRule["origem"];
  confianca: number | null;
}

const _cache = new Map<string, { mapa: Map<string, LearnedRule>; em: number }>();

function cacheKey(provider: string, ramo: string, corretoraId: string | null): string {
  return `${provider}:${ramo}:${corretoraId ?? "_default_"}`;
}

/**
 * Regras ATIVAS para (provider, ramo), combinando default (corretora_id NULL) e
 * override da corretora — a regra da corretora vence a default na mesma chave.
 */
export async function carregarRegras(
  provider: string,
  ramo: string,
  corretoraId: string | null,
): Promise<Map<string, LearnedRule>> {
  const ck = cacheKey(provider, ramo, corretoraId);
  const agora = Date.now();
  const cached = _cache.get(ck);
  if (cached && agora - cached.em < TTL_MS) return cached.mapa;
  try {
    const sb = getSupabaseAdmin();
    let q = sb
      .from("quote_mapping_rule")
      .select("corretora_id, chave_alvo, entrada_normalizada, valor_resolvido, origem, confianca")
      .eq("provider", provider)
      .eq("ramo", ramo)
      .eq("status", "ativo");
    q = corretoraId
      ? q.or(`corretora_id.is.null,corretora_id.eq.${corretoraId}`)
      : q.is("corretora_id", null);
    const { data, error } = await q;
    if (error) {
      logger.warn("[mapper.rules] leitura falhou; sem regras ativas", { erro: error.message });
      return new Map(); // NÃO cacheia erro → re-tenta na próxima cotação
    }
    const linhas = (data ?? []) as RuleRow[];
    const mapa = new Map<string, LearnedRule>();
    // Default primeiro; a regra da corretora (se houver) sobrescreve a mesma chave.
    for (const l of linhas.filter((x) => x.corretora_id === null)) setRegra(mapa, l);
    for (const l of linhas.filter((x) => x.corretora_id !== null)) setRegra(mapa, l);
    _cache.set(ck, { mapa, em: agora });
    return mapa;
  } catch (e) {
    logger.warn("[mapper.rules] exceção na leitura; sem regras ativas", {
      erro: (e as Error).message,
    });
    return new Map();
  }
}

function setRegra(mapa: Map<string, LearnedRule>, l: RuleRow): void {
  mapa.set(chaveRegra(l.chave_alvo, l.entrada_normalizada), {
    chaveAlvo: l.chave_alvo,
    entradaNormalizada: l.entrada_normalizada,
    valorResolvido: l.valor_resolvido,
    origem: l.origem,
    confianca: l.confianca ?? 0,
  });
}

/**
 * Grava uma regra resolvida pelo LLM como `pendente` (revisão humana). Não
 * duplica se já existe qualquer linha para a mesma (corretora,provider,ramo,
 * chave,entrada). Best-effort: erros são logados, nunca propagados.
 */
export async function persistirRegraAprendida(
  provider: string,
  ramo: string,
  corretoraId: string | null,
  regra: LearnedRule,
): Promise<void> {
  try {
    const sb = getSupabaseAdmin();
    let dup = sb
      .from("quote_mapping_rule")
      .select("id")
      .eq("provider", provider)
      .eq("ramo", ramo)
      .eq("chave_alvo", regra.chaveAlvo)
      .eq("entrada_normalizada", regra.entradaNormalizada);
    dup = corretoraId
      ? dup.eq("corretora_id" as never, corretoraId as never)
      : dup.is("corretora_id", null);
    const { data: existente } = await dup.maybeSingle();
    if (existente) return; // já existe (pendente/ativo/arquivado) → não recria

    const { error } = await sb.from("quote_mapping_rule").insert({
      corretora_id: corretoraId,
      provider,
      ramo,
      chave_alvo: regra.chaveAlvo,
      entrada_normalizada: regra.entradaNormalizada,
      valor_resolvido: regra.valorResolvido,
      origem: regra.origem,
      status: "pendente",
      confianca: regra.confianca,
    } as never);
    if (error) {
      logger.warn("[mapper.rules] falha gravando regra pendente", { erro: error.message });
    }
  } catch (e) {
    logger.warn("[mapper.rules] exceção gravando regra pendente", { erro: (e as Error).message });
  }
}

/** Apenas para testes: zera o cache de regras. */
export function _resetRuleCache(): void {
  _cache.clear();
}
