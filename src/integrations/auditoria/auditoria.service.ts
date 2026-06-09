/**
 * Serviço de gravação da trilha de auditoria (`auditoria_eventos`).
 *
 * Grava com service_role (bypassa RLS) e é SEMPRE não-fatal: uma falha no log
 * de auditoria nunca pode abortar o fluxo de negócio (mesmo princípio de
 * `SupabasePersistence.registrarLog`). O campo `detalhe` passa por `redigir()`
 * antes de persistir, garantindo que nenhum segredo (senha/token/credencial)
 * chegue à tabela.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "../whatsapp/supabase";
import { logger, redigir } from "../../utils/logger";

export type CategoriaAuditoria =
  | "acesso"
  | "usuarios"
  | "whatsapp"
  | "cotacao"
  | "segfy"
  | "agente"
  | "aprendizado"
  | "plataforma"
  | "apolice"
  | "mapeamento";

export interface EventoAuditoriaInput {
  operadorId?: string | null;
  atorEmail?: string | null;
  atorUserId?: string | null;
  categoria: CategoriaAuditoria;
  acao: string;
  recurso?: string | null;
  recursoId?: string | null;
  metodo?: string | null;
  rota?: string | null;
  statusHttp?: number | null;
  sucesso?: boolean;
  ip?: string | null;
  userAgent?: string | null;
  detalhe?: Record<string, unknown> | null;
}

/**
 * Insere um evento na trilha. Nunca lança: em erro só emite warn.
 * `client` é injetável para testes; em produção usa o singleton service_role.
 */
export async function registrarAuditoria(
  evento: EventoAuditoriaInput,
  client?: SupabaseClient,
): Promise<void> {
  try {
    const sb = client ?? getSupabaseAdmin();
    const { error } = await sb.from("auditoria_eventos").insert({
      operador_id: evento.operadorId ?? null,
      ator_email: evento.atorEmail ?? null,
      ator_user_id: evento.atorUserId ?? null,
      categoria: evento.categoria,
      acao: evento.acao,
      recurso: evento.recurso ?? null,
      recurso_id: evento.recursoId ?? null,
      metodo: evento.metodo ?? null,
      rota: evento.rota ?? null,
      status_http: evento.statusHttp ?? null,
      sucesso: evento.sucesso ?? true,
      ip: evento.ip ?? null,
      user_agent: evento.userAgent ?? null,
      // Redige qualquer chave sensível em qualquer profundidade antes de gravar.
      detalhe: evento.detalhe ? (redigir(evento.detalhe) as Record<string, unknown>) : null,
    });
    if (error) {
      logger.warn("[auditoria] insert falhou", { codigo: error.code, acao: evento.acao });
    }
  } catch (e) {
    // Tabela ausente, service_role faltando, rede: nunca propaga.
    logger.warn("[auditoria] registrarAuditoria erro", { erro: (e as Error).message });
  }
}
