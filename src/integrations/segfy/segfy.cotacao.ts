/**
 * Disparo de cotação automática (HFy) e polling do resultado.
 * Usa o transporte genérico (segfy.api) e valida tudo com Zod.
 * A formatação para WhatsApp vive em segfy.format.ts (pura/testável).
 */
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import { segfyAPI } from "./segfy.api";
import { SEGFY_ENDPOINTS } from "./endpoints";
import {
  PayloadCotacaoAutoSchema,
  CotacaoDisparoResponseSchema,
  CotacaoStatusResponseSchema,
  type PayloadCotacaoAuto,
  type ResultadoCotacaoItem,
} from "./segfy.types";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function dispararCotacaoAuto(
  payload: PayloadCotacaoAuto,
): Promise<{ cotacaoId: string; resultados: ResultadoCotacaoItem[] }> {
  const valido = PayloadCotacaoAutoSchema.parse(payload);
  logger.info("Segfy: disparando cotação auto", { segurado: valido.segurado_id });

  const disparo = CotacaoDisparoResponseSchema.parse(
    await segfyAPI("POST", SEGFY_ENDPOINTS.cotacoes.auto, valido),
  );

  const resultados = await aguardarResultadoCotacao(disparo.cotacao_id);
  return { cotacaoId: disparo.cotacao_id, resultados };
}

export async function aguardarResultadoCotacao(cotacaoId: string): Promise<ResultadoCotacaoItem[]> {
  const env = getEnv();
  const inicio = Date.now();

  while (Date.now() - inicio < env.SEGFY_COTACAO_TIMEOUT_MS) {
    const r = CotacaoStatusResponseSchema.parse(
      await segfyAPI("GET", SEGFY_ENDPOINTS.cotacoes.byId(cotacaoId)),
    );
    if (r.status === "concluida") return r.resultados;
    if (r.status === "erro") throw new Error(`Cotação ${cotacaoId} retornou erro na Segfy`);
    await sleep(env.SEGFY_COTACAO_INTERVAL_MS);
  }

  throw new Error(`Timeout aguardando cotação ${cotacaoId}`);
}
