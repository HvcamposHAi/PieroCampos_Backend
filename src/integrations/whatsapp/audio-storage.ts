/**
 * Upload do áudio ORIGINAL (nota de voz) para o Supabase Storage, para o operador
 * poder reouvir. Bucket PRIVADO `audios-whatsapp` (áudio do cliente é dado pessoal
 * — LGPD); o front gera signed URL sob demanda. Usa o client service_role já
 * existente (bypassa RLS no upload).
 *
 * Best-effort: NUNCA lança. Em qualquer falha (bucket ausente, rede) retorna null,
 * e o handler só deixa `mensagens.midia_url=null` — a transcrição e a resposta da
 * Bia seguem normais. Guardamos o PATH relativo (não URL assinada, que expira).
 */
import { getSupabaseAdmin } from "./supabase";
import { logger } from "../../utils/logger";

export const BUCKET_AUDIOS = "audios-whatsapp";

function extDoMime(mimetype: string): string {
  const mt = (mimetype ?? "").toLowerCase();
  if (mt.startsWith("audio/mpeg")) return "mp3";
  if (mt.startsWith("audio/mp4") || mt.includes("m4a")) return "m4a";
  if (mt.startsWith("audio/wav") || mt.startsWith("audio/x-wav")) return "wav";
  if (mt.startsWith("audio/webm")) return "webm";
  if (mt.startsWith("audio/aac")) return "aac";
  return "ogg";
}

/** Mimetype "limpo" p/ o Storage (sem o `; codecs=opus` que o WhatsApp manda). */
function mimeBase(mimetype: string): string {
  return (mimetype ?? "audio/ogg").split(";")[0]!.trim() || "audio/ogg";
}

/**
 * Sobe o áudio e retorna o path (`${providerMsgId}.${ext}`) ou null. O nome usa o
 * providerMsgId (id Baileys, único) — idempotente por natureza (upsert:true evita
 * erro em reprocessamento). Sem providerMsgId → não sobe (retorna null).
 */
export async function subirAudioWhatsapp(args: {
  providerMsgId?: string;
  audio: Buffer;
  mimetype: string;
}): Promise<{ path: string } | null> {
  if (!args.providerMsgId) return null;
  const path = `${args.providerMsgId}.${extDoMime(args.mimetype)}`;
  try {
    const sb = getSupabaseAdmin();
    const { error } = await sb.storage.from(BUCKET_AUDIOS).upload(path, args.audio, {
      contentType: mimeBase(args.mimetype),
      upsert: true,
    });
    if (error) {
      logger.warn("[audio-storage] upload falhou", { erro: error.message });
      return null;
    }
    return { path };
  } catch (e) {
    logger.warn("[audio-storage] upload lançou", { erro: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
