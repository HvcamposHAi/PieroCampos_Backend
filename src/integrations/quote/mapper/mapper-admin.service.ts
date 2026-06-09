/**
 * Leitura/curadoria do mapeamento dinâmico para o Admin (Admin › Mapeamento).
 * Escopado por corretora (service_role ignora RLS → o filtro é a defesa).
 */
import { getSupabaseAdmin } from "../../whatsapp/supabase";
import { logger } from "../../../utils/logger";
import { obterSchemaAdmin } from "./schema-store";
import { lerMapperDinamicoAtivo, _resetMapperToggleCache } from "./dynamic-mapper.service";
import { _resetRuleCache } from "./rule-cache";
import type { ProviderSchema } from "./provider-schema.types";

export interface RegraRow {
  id: string;
  corretora_id: string | null;
  chave_alvo: string;
  entrada_normalizada: string;
  valor_resolvido: string;
  origem: string;
  status: string;
  confianca: number | null;
  criado_em: string;
  aprovado_em: string | null;
  aprovado_por: string | null;
}

export interface MapeamentoAdmin {
  provider: string;
  ramo: string;
  ativo: boolean;
  schema: { padrao: ProviderSchema | null; override: ProviderSchema | null };
  regras: RegraRow[];
}

const COLUNAS_REGRA =
  "id, corretora_id, chave_alvo, entrada_normalizada, valor_resolvido, origem, status, confianca, criado_em, aprovado_em, aprovado_por";

export async function obterMapeamentoAdmin(
  provider: string,
  ramo: string,
  corretoraId: string,
): Promise<MapeamentoAdmin> {
  const sb = getSupabaseAdmin();
  const [schema, regrasRes, ativo] = await Promise.all([
    obterSchemaAdmin(provider, ramo, corretoraId),
    sb
      .from("quote_mapping_rule")
      .select(COLUNAS_REGRA)
      .eq("provider", provider)
      .eq("ramo", ramo)
      .neq("status", "arquivado")
      .or(`corretora_id.is.null,corretora_id.eq.${corretoraId}`)
      .order("chave_alvo", { ascending: true }),
    lerMapperDinamicoAtivo(corretoraId),
  ]);
  if (regrasRes.error) throw new Error(`obterMapeamentoAdmin(regras): ${regrasRes.error.message}`);
  return {
    provider,
    ramo,
    ativo,
    schema,
    regras: (regrasRes.data ?? []) as RegraRow[],
  };
}

/** Aprova uma regra (pendente→ativo). Arquiva a ativa conflitante do mesmo segmento. */
export async function aprovarRegra(id: string, corretoraId: string, porEmail: string | null): Promise<void> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("quote_mapping_rule")
    .select("provider, ramo, chave_alvo, entrada_normalizada, corretora_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`aprovarRegra(busca): ${error.message}`);
  if (!data) throw new Error("regra não encontrada");
  const r = data as {
    provider: string;
    ramo: string;
    chave_alvo: string;
    entrada_normalizada: string;
    corretora_id: string | null;
  };
  // Defesa cross-tenant: só regras da corretora (ou a default global NULL).
  if (r.corretora_id !== null && r.corretora_id !== corretoraId) {
    throw new Error("aprovarRegra: regra de outra corretora (404)");
  }

  // Arquiva a ativa atual do mesmo segmento (índice parcial garante no máx. 1).
  let qArq = sb
    .from("quote_mapping_rule")
    .update({ status: "arquivado" } as never)
    .eq("provider", r.provider)
    .eq("ramo", r.ramo)
    .eq("chave_alvo", r.chave_alvo)
    .eq("entrada_normalizada", r.entrada_normalizada)
    .eq("status", "ativo");
  qArq = r.corretora_id === null ? qArq.is("corretora_id", null) : qArq.eq("corretora_id" as never, r.corretora_id as never);
  const { error: arqErr } = await qArq;
  if (arqErr) throw new Error(`aprovarRegra(arquivar): ${arqErr.message}`);

  const { error: ativErr } = await sb
    .from("quote_mapping_rule")
    .update({ status: "ativo", aprovado_em: new Date().toISOString(), aprovado_por: porEmail } as never)
    .eq("id", id);
  if (ativErr) throw new Error(`aprovarRegra(ativar): ${ativErr.message}`);
  _resetRuleCache();
  logger.info("[mapper.admin] regra aprovada", { id, por: porEmail });
}

/** Arquiva uma regra (se era ativa, o segmento volta ao default/LLM). */
export async function arquivarRegra(id: string, corretoraId: string): Promise<void> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("quote_mapping_rule")
    .select("corretora_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`arquivarRegra(busca): ${error.message}`);
  if (!data) throw new Error("regra não encontrada");
  const dono = (data as { corretora_id: string | null }).corretora_id;
  if (dono !== null && dono !== corretoraId) {
    throw new Error("arquivarRegra: regra de outra corretora (404)");
  }
  const { error: updErr } = await sb
    .from("quote_mapping_rule")
    .update({ status: "arquivado" } as never)
    .eq("id", id);
  if (updErr) throw new Error(`arquivarRegra: ${updErr.message}`);
  _resetRuleCache();
  logger.info("[mapper.admin] regra arquivada", { id });
}

/** Invalida caches in-process após edição de schema/toggle (set imediato). */
export function invalidarCachesMapeamento(): void {
  _resetRuleCache();
  _resetMapperToggleCache();
}
