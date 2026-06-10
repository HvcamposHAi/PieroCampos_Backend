/**
 * Curadoria das regras de seletor de portal (Admin). Espelha mapper-admin:
 * listar regras, aprovar (pendente→ativo, arquivando a ativa conflitante) e
 * arquivar. Escopo por corretora (service_role). Invalida o cache após edição.
 */
import { getSupabaseAdmin } from "../../whatsapp/supabase";
import { _resetPortalRuleCache } from "./portal-rule-cache";
import { logger } from "../../../utils/logger";

export interface RegraPortalRow {
  id: string;
  seguradora: string;
  acao: string;
  seletor_resolvido: string;
  origem: string;
  status: string;
  confianca: number | null;
  criado_em: string;
}

const COLS = "id,seguradora,acao,seletor_resolvido,origem,status,confianca,criado_em";

/** Lista regras (pendentes primeiro) da corretora + defaults globais. */
export async function listarRegrasPortal(corretoraId: string): Promise<RegraPortalRow[]> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("portal_selector_rule")
    .select(COLS)
    .or(`corretora_id.is.null,corretora_id.eq.${corretoraId}`)
    .order("status", { ascending: true })
    .order("criado_em", { ascending: false });
  if (error) throw new Error(`listarRegrasPortal: ${error.message}`);
  return (data ?? []) as RegraPortalRow[];
}

/** Aprova (pendente→ativo) e arquiva a ativa conflitante (mesma seguradora+ação). */
export async function aprovarRegraPortal(
  id: string,
  corretoraId: string,
  porEmail: string | null,
): Promise<void> {
  const sb = getSupabaseAdmin();
  const { data: regra, error: e1 } = await sb
    .from("portal_selector_rule")
    .select("id,seguradora,acao,corretora_id")
    .eq("id", id)
    .or(`corretora_id.is.null,corretora_id.eq.${corretoraId}`)
    .maybeSingle();
  if (e1 || !regra) throw new Error("regra_nao_encontrada");
  const r = regra as { seguradora: string; acao: string; corretora_id: string | null };
  // Arquiva a ATIVA conflitante (mesmo escopo + seguradora + ação).
  let arq = sb
    .from("portal_selector_rule")
    .update({ status: "arquivado" } as never)
    .ilike("seguradora", r.seguradora)
    .eq("acao", r.acao)
    .eq("status", "ativo")
    .neq("id", id);
  arq = r.corretora_id ? arq.eq("corretora_id" as never, r.corretora_id as never) : arq.is("corretora_id", null);
  await arq;
  const { error: e2 } = await sb
    .from("portal_selector_rule")
    .update({ status: "ativo", aprovado_em: new Date().toISOString(), aprovado_por: porEmail } as never)
    .eq("id", id);
  if (e2) throw new Error(`aprovarRegraPortal: ${e2.message}`);
  _resetPortalRuleCache();
  logger.info("[portal.admin] regra aprovada", { id, por: porEmail });
}

export async function arquivarRegraPortal(id: string, corretoraId: string): Promise<void> {
  const sb = getSupabaseAdmin();
  const { error } = await sb
    .from("portal_selector_rule")
    .update({ status: "arquivado" } as never)
    .eq("id", id)
    .or(`corretora_id.is.null,corretora_id.eq.${corretoraId}`);
  if (error) throw new Error(`arquivarRegraPortal: ${error.message}`);
  _resetPortalRuleCache();
}
