/**
 * Lançamento de comissão no Segfy, com idempotência.
 *
 * Verifica se já existe comissão para a apólice antes de lançar — evita o
 * problema histórico de duplicata na Piero. A garantia FORTE vem do índice
 * único `uq_comissoes_*` no banco; esta checagem é a primeira barreira.
 */
import { z } from "zod";
import { logger } from "../../utils/logger";
import { segfyAPI } from "./segfy.api";
import { SEGFY_ENDPOINTS } from "./endpoints";

const ComissoesExistentesSchema = z.object({
  total: z.number().int().nonnegative().default(0),
});

export async function lancarComissao(params: {
  apolice_id: string;
  percentual: number;
  valor: number;
  operador_nome: string;
}): Promise<void> {
  const existente = ComissoesExistentesSchema.parse(
    await segfyAPI("GET", SEGFY_ENDPOINTS.comissoes.byApolice(params.apolice_id)),
  );

  if (existente.total > 0) {
    logger.warn("Segfy: comissão já existe para esta apólice — ignorando", {
      apolice_id: params.apolice_id,
    });
    return;
  }

  await segfyAPI("POST", SEGFY_ENDPOINTS.comissoes.base, params);
  logger.info("Segfy: comissão lançada", { apolice_id: params.apolice_id, valor: params.valor });
}
