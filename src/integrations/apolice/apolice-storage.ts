/**
 * Upload do PDF da apólice emitida para o Supabase Storage. Bucket PRIVADO
 * `apolices` (documento do cliente — LGPD); o front gera signed URL sob demanda.
 * Usa o client service_role (bypassa RLS no upload). Espelha audio-storage.ts.
 *
 * Best-effort: NUNCA lança. Em qualquer falha retorna null e o chamador grava
 * `apolices.pdf_url=null` (a apólice ainda é persistida). Guarda o PATH relativo
 * (não a URL assinada, que expira). Path keyed por propostaId → re-emissão
 * sobrescreve (upsert), sem duplicar.
 */
import { getSupabaseAdmin } from "../whatsapp/supabase";
import { logger } from "../../utils/logger";

export const BUCKET_APOLICES = "apolices";

export async function subirApolicePdf(args: {
  corretoraId: string;
  propostaId: string;
  bytes: Buffer;
  contentType?: string;
}): Promise<{ path: string } | null> {
  const path = `${args.corretoraId}/${args.propostaId}.pdf`;
  try {
    const sb = getSupabaseAdmin();
    const { error } = await sb.storage.from(BUCKET_APOLICES).upload(path, args.bytes, {
      contentType: args.contentType ?? "application/pdf",
      upsert: true,
    });
    if (error) {
      logger.warn("[apolice-storage] upload falhou", { erro: error.message });
      return null;
    }
    return { path };
  } catch (e) {
    logger.warn("[apolice-storage] upload lançou", { erro: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
