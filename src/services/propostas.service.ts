/**
 * Ciclo de vida da PROPOSTA (transmitida → … → aprovada → emitida). Hoje o
 * backend só marcava a cotação "enviada" (rota /escolher); a proposta não existia.
 * Esta service cria a proposta a partir de uma cotação escolhida e permite o
 * operador atualizar o status — o pré-requisito para o botão "Gerar apólice".
 *
 * Escopo por corretora (service_role + filtro manual). A seguradora da proposta
 * vem da escolha da cotação (escolha_seguradora) quando não informada.
 */
import { SupabasePersistence } from "../integrations/persistence/supabase-persistence";
import { getSupabaseAdmin } from "../integrations/whatsapp/supabase";
import type { StatusPropostaDb } from "../integrations/segfy/persistence.port";
import { logger } from "../utils/logger";

interface CotacaoEscolha {
  cliente_id: string;
  escolha_seguradora: string | null;
}

export async function criarPropostaDeCotacao(args: {
  corretoraId: string;
  cotacaoId: string;
  seguradora?: string;
  numeroProposta?: string | null;
  operadorId?: string | null;
}): Promise<{ propostaId: string }> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("cotacoes")
    .select("cliente_id, escolha_seguradora")
    .eq("id", args.cotacaoId)
    .eq("corretora_id" as never, args.corretoraId as never)
    .maybeSingle();
  if (error || !data) throw new Error("cotacao_nao_encontrada");
  const cot = data as unknown as CotacaoEscolha;
  const seguradora = (args.seguradora ?? cot.escolha_seguradora ?? "").trim();
  if (!seguradora) throw new Error("seguradora_obrigatoria");

  const persist = new SupabasePersistence(undefined, args.corretoraId);
  return persist.salvarProposta({
    clienteId: cot.cliente_id,
    cotacaoId: args.cotacaoId,
    seguradora,
    numeroProposta: args.numeroProposta ?? null,
    status: "transmitida",
    operadorTransmissaoId: args.operadorId ?? null,
  });
}

export async function atualizarStatusProposta(args: {
  corretoraId: string;
  propostaId: string;
  status: StatusPropostaDb;
}): Promise<void> {
  const persist = new SupabasePersistence(undefined, args.corretoraId);
  await persist.atualizarPropostaStatus(args.propostaId, { status: args.status });
  logger.info("[propostas] status atualizado", { propostaId: args.propostaId, status: args.status });
}
