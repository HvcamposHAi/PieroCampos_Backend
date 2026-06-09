/**
 * Leitura/escrita do SCHEMA do provedor (tabela quote_provider_schema).
 *
 * Modelo "default + override" por corretora (espelha agente-config.service):
 * uma linha PADRÃO (corretora_id IS NULL) vale para todas; cada corretora pode
 * ter um override (corretora_id setado) que substitui o conjunto de campos.
 *
 * FAIL-CLOSED: erro de leitura, ausência de linha ou JSON malformado →
 * `obterSchemaEfetivo` devolve null e o chamador cai no mapper hardcoded.
 */
import { z } from "zod";
import { getSupabaseAdmin } from "../../whatsapp/supabase";
import { logger } from "../../../utils/logger";
import type { ProviderField, ProviderSchema } from "./provider-schema.types";

const enumOptionSchema = z.object({
  value: z.string().min(1),
  descricao: z.string().default(""),
  sinonimos: z.array(z.string()).default([]),
});
const campoSchema = z.object({
  chaveAlvo: z.string().min(1),
  tipo: z.enum(["string", "number", "boolean", "enum", "passthrough"]),
  obrigatorio: z.boolean().default(false),
  descricao: z.string().default(""),
  opcoes: z.array(enumOptionSchema).optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  fontes: z.array(z.string()).default([]),
});
export const camposSchema = z.array(campoSchema);

interface SchemaRow {
  corretora_id: string | null;
  provider: string;
  ramo: string;
  campos: unknown;
  versao: number;
}

const COLUNAS = "corretora_id, provider, ramo, campos, versao";

/** Faz o parse defensivo de `campos` (jsonb). Inválido → null (FAIL-CLOSED). */
function parseCampos(raw: unknown): ProviderField[] | null {
  const r = camposSchema.safeParse(raw);
  if (!r.success) {
    logger.warn("[mapper.schema] campos malformados; ignorando linha");
    return null;
  }
  return r.data as ProviderField[];
}

/**
 * Schema EFETIVO (override da corretora, senão o default global) para
 * provider+ramo. null em qualquer falha → fallback hardcoded.
 */
export async function obterSchemaEfetivo(
  provider: string,
  ramo: string,
  corretoraId: string | null,
): Promise<ProviderSchema | null> {
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("quote_provider_schema")
      .select(COLUNAS)
      .eq("provider", provider)
      .eq("ramo", ramo);
    if (error) {
      logger.warn("[mapper.schema] leitura falhou; fallback hardcoded", { erro: error.message });
      return null;
    }
    const linhas = (data ?? []) as SchemaRow[];
    if (linhas.length === 0) return null;
    const override = corretoraId
      ? linhas.find((l) => l.corretora_id === corretoraId) ?? null
      : null;
    const padrao = linhas.find((l) => l.corretora_id === null) ?? null;
    const escolhida = override ?? padrao;
    if (!escolhida) return null;
    const campos = parseCampos(escolhida.campos);
    if (!campos) return null;
    return { provider, ramo, versao: escolhida.versao ?? 1, campos };
  } catch (e) {
    logger.warn("[mapper.schema] exceção na leitura; fallback hardcoded", {
      erro: (e as Error).message,
    });
    return null;
  }
}

/** Padrão + override da corretora para a tela do Admin. */
export async function obterSchemaAdmin(
  provider: string,
  ramo: string,
  corretoraId: string,
): Promise<{ padrao: ProviderSchema | null; override: ProviderSchema | null }> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("quote_provider_schema")
    .select(COLUNAS)
    .eq("provider", provider)
    .eq("ramo", ramo)
    .or(`corretora_id.is.null,corretora_id.eq.${corretoraId}`);
  if (error) throw new Error(`obterSchemaAdmin: ${error.message}`);
  const linhas = (data ?? []) as SchemaRow[];
  const mk = (l: SchemaRow | undefined): ProviderSchema | null => {
    if (!l) return null;
    const campos = parseCampos(l.campos);
    return campos ? { provider, ramo, versao: l.versao ?? 1, campos } : null;
  };
  return {
    padrao: mk(linhas.find((l) => l.corretora_id === null)),
    override: mk(linhas.find((l) => l.corretora_id === corretoraId)),
  };
}

/**
 * Salva o OVERRIDE de schema da corretora (select-then-update/insert, como
 * salvarConfig — a unicidade vive em índices parciais). Valida `campos` via Zod
 * ANTES de gravar; entrada inválida lança (a rota responde 422).
 */
export async function salvarSchema(input: {
  corretoraId: string;
  provider: string;
  ramo: string;
  campos: ProviderField[];
  porEmail?: string | null;
}): Promise<void> {
  const validacao = camposSchema.safeParse(input.campos);
  if (!validacao.success) {
    throw new Error(`salvarSchema: campos inválidos — ${validacao.error.message}`);
  }
  const sb = getSupabaseAdmin();
  const { data: existente, error: selErr } = await sb
    .from("quote_provider_schema")
    .select("id, versao")
    .eq("corretora_id" as never, input.corretoraId as never)
    .eq("provider", input.provider)
    .eq("ramo", input.ramo)
    .maybeSingle();
  if (selErr) throw new Error(`salvarSchema(select): ${selErr.message}`);

  const base = {
    corretora_id: input.corretoraId,
    provider: input.provider,
    ramo: input.ramo,
    campos: validacao.data,
    atualizado_em: new Date().toISOString(),
    atualizado_por: input.porEmail ?? null,
  };
  if (existente) {
    const versao = ((existente as { versao?: number }).versao ?? 1) + 1;
    const { error } = await sb
      .from("quote_provider_schema")
      .update({ ...base, versao } as never)
      .eq("id", (existente as { id: string }).id);
    if (error) throw new Error(`salvarSchema(update): ${error.message}`);
  } else {
    const { error } = await sb
      .from("quote_provider_schema")
      .insert({ ...base, versao: 1 } as never);
    if (error) throw new Error(`salvarSchema(insert): ${error.message}`);
  }
  logger.info("[mapper.schema] override salvo", {
    corretora_id: input.corretoraId,
    provider: input.provider,
    ramo: input.ramo,
    por: input.porEmail,
  });
}
