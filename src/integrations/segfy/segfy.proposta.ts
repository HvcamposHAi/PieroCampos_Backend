/**
 * Criação de proposta no Segfy (quando o cliente aceita uma cotação).
 */
import { z } from "zod";
import { segfyAPI } from "./segfy.api";
import { SEGFY_ENDPOINTS } from "./endpoints";

const PropostaResponseSchema = z.object({
  id: z.string().min(1),
  numero: z.string().optional().default(""),
});

export async function criarProposta(params: {
  cotacao_id_segfy: string;
  segurado_id: string;
  seguradora_escolhida: string;
  plano_escolhido: string;
  operador_nome: string;
}): Promise<{ proposta_id: string; numero_proposta: string }> {
  const resp = PropostaResponseSchema.parse(
    await segfyAPI("POST", SEGFY_ENDPOINTS.propostas.base, {
      cotacao_id: params.cotacao_id_segfy,
      segurado_id: params.segurado_id,
      seguradora: params.seguradora_escolhida,
      plano: params.plano_escolhido,
      corretor: params.operador_nome,
    }),
  );
  return { proposta_id: resp.id, numero_proposta: resp.numero };
}
