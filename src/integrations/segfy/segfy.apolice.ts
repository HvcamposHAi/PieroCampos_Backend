/**
 * Registro de apólice emitida no Segfy.
 */
import { z } from "zod";
import { segfyAPI } from "./segfy.api";
import { SEGFY_ENDPOINTS } from "./endpoints";

const ApoliceResponseSchema = z.object({ id: z.string().min(1) });

export async function registrarApolice(params: {
  proposta_id: string;
  numero_apolice: string;
  inicio_vigencia: string;
  fim_vigencia: string;
  premio_total: number;
  pdf_url?: string;
}): Promise<{ apolice_id: string }> {
  const resp = ApoliceResponseSchema.parse(
    await segfyAPI("POST", SEGFY_ENDPOINTS.apolices.base, params),
  );
  return { apolice_id: resp.id };
}
