/**
 * Persistência ISOLADA do Copiloto (gestor). Escreve SOMENTE em `gestor_conversas`
 * e `gestor_mensagens` — nunca em `conversas`/`mensagens`/`clientes`. Esse
 * isolamento é o que garante que o histórico do gestor não apareça em nenhuma das
 * views do funil do cliente (vw_fila_conversas, vw_funil_*) e não infle relatórios.
 */
import { getSupabaseAdmin } from "./supabase";
import { logger } from "../../utils/logger";
import type { MensagemTurno } from "../claude/claude.client";

export type OrigemGestor = "gestor" | "assistente";

/**
 * Garante uma `gestor_conversas` para (canal_id, wa_jid). Read-then-write (sem
 * UNIQUE-upsert para não depender do nome da constraint) — corrida na 1ª mensagem
 * simultânea é tolerável (índice único impede duplicata silenciosa de qualquer modo).
 */
export async function obterOuCriarGestorConversa(input: {
  corretoraId: string;
  canalId: string;
  gestorId: string;
  jid: string;
}): Promise<string> {
  const sb = getSupabaseAdmin();
  const { data: existente, error: errSel } = await sb
    .from("gestor_conversas")
    .select("id")
    .eq("canal_id", input.canalId)
    .eq("wa_jid", input.jid)
    .maybeSingle();
  if (errSel) throw errSel;
  if ((existente as { id?: string } | null)?.id) return (existente as { id: string }).id;
  const { data: inserido, error: errIns } = await sb
    .from("gestor_conversas")
    .insert({
      corretora_id: input.corretoraId,
      canal_id: input.canalId,
      gestor_id: input.gestorId,
      wa_jid: input.jid,
    })
    .select("id")
    .single();
  if (errIns) throw errIns;
  return (inserido as { id: string }).id;
}

/** Registra uma mensagem do thread do gestor (entrada do gestor ou saída do Copiloto). */
export async function registrarMsgGestor(input: {
  gestorConversaId: string;
  origem: OrigemGestor;
  corpo: string;
  midiaTipo?: string | null;
  toolsUsadas?: string[] | null;
}): Promise<void> {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("gestor_mensagens").insert({
    gestor_conversa_id: input.gestorConversaId,
    origem: input.origem,
    corpo: input.corpo,
    midia_tipo: input.midiaTipo ?? null,
    tools_usadas: input.toolsUsadas && input.toolsUsadas.length ? input.toolsUsadas : null,
  });
  if (error) throw error;
  // Toca o ultima_mensagem_em (best-effort; não bloqueia o fluxo se falhar).
  await sb
    .from("gestor_conversas")
    .update({ ultima_mensagem_em: new Date().toISOString() })
    .eq("id", input.gestorConversaId)
    .then(undefined, (e: unknown) =>
      logger.warn("[gestor.persist] toca ultima_mensagem_em falhou", { erro: (e as Error).message }),
    );
}

/**
 * Carrega o histórico recente como turnos alternados para o Claude. `gestor`→user,
 * `assistente`→assistant. Pega as últimas `limite*2` linhas e devolve em ordem
 * cronológica. A mensagem ATUAL já foi persistida pelo caller, então ela entra
 * como o último turno `user`.
 */
export async function carregarHistoricoGestor(
  gestorConversaId: string,
  limite = 12,
): Promise<MensagemTurno[]> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("gestor_mensagens")
    .select("origem, corpo, enviada_em")
    .eq("gestor_conversa_id", gestorConversaId)
    .order("enviada_em", { ascending: false })
    .limit(limite * 2);
  if (error) {
    logger.warn("[gestor.persist] carregarHistorico falhou", { erro: error.message });
    return [];
  }
  const linhas = ((data ?? []) as Array<{ origem: string; corpo: string | null }>).reverse();
  const turnos: MensagemTurno[] = [];
  for (const l of linhas) {
    const role = l.origem === "assistente" ? "assistant" : "user";
    const content = (l.corpo ?? "").trim();
    if (!content) continue;
    // Garante alternância: funde turnos consecutivos do mesmo papel.
    const ultimo = turnos[turnos.length - 1];
    if (ultimo && ultimo.role === role) {
      ultimo.content = `${ultimo.content}\n${content}`;
    } else {
      turnos.push({ role, content });
    }
  }
  // A API exige que o histórico comece com 'user'.
  while (turnos.length && turnos[0]!.role !== "user") turnos.shift();
  return turnos;
}
