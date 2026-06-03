/**
 * Transcrição de notas de voz (speech-to-text) — usado pelo handler de mensagens
 * do WhatsApp (eventHandlers) quando o cliente manda áudio em vez de texto.
 *
 * Por que um provedor dedicado (e não o Claude): a Messages API da Anthropic
 * aceita só texto e imagem — não há entrada de áudio. A transcrição nativa do
 * WhatsApp é on-device e não trafega no protocolo (Baileys recebe só a mídia
 * crua). Logo, a inferência crua vai para um provedor externo; TODA a
 * orquestração (flag, guardas, fallback, persistência, storage) é nossa.
 *
 * Padrão espelha `lib/cep.ts`: módulo puro, provider INJETÁVEL (testes), NUNCA
 * lança (retorna null em qualquer falha) e loga só status/mensagem — NUNCA o
 * corpo da resposta nem o buffer de áudio. `getEnv()` é lido DENTRO das funções
 * (não no topo) para manter o import puro em testes que não têm .env.
 */
import axios from "axios";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";

export interface ResultadoTranscricao {
  /** Texto transcrito, já com trim. Nunca vazio quando retornado. */
  texto: string;
  idioma?: string;
  duracaoSeg?: number;
}

/**
 * Provedor injetável. Recebe os bytes + metadados e devolve o texto, ou null em
 * falha. NÃO deve lançar (o orquestrador também envolve em try/catch por garantia).
 */
export type TranscritorProvider = (args: {
  audio: Buffer;
  mimetype: string;
  duracaoSeg?: number;
  apiKey: string;
  model: string;
  idiomaHint?: string;
}) => Promise<ResultadoTranscricao | null>;

/** Prefixos de mimetype aceitos (v1). Áudios do WhatsApp chegam como ogg/opus. */
const MIMETYPES_OK = ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/mp4a", "audio/m4a", "audio/wav", "audio/x-wav", "audio/webm", "audio/aac"];

/**
 * Guarda pura (exportada p/ teste): decide se o áudio pode ir para o provedor.
 * Rejeita pré-HTTP (sem gasto) mimetype não suportado, duração ou tamanho acima
 * do teto. Duração ausente NÃO bloqueia — o limite de bytes ainda protege.
 */
export function audioElegivel(a: {
  mimetype: string;
  duracaoSeg?: number;
  bytes: number;
  maxSeg: number;
  maxBytes: number;
}): { ok: true } | { ok: false; motivo: "mimetype" | "duracao" | "tamanho" } {
  const mt = (a.mimetype ?? "").toLowerCase();
  if (!MIMETYPES_OK.some((p) => mt.startsWith(p))) return { ok: false, motivo: "mimetype" };
  if (typeof a.duracaoSeg === "number" && a.duracaoSeg > a.maxSeg) return { ok: false, motivo: "duracao" };
  if (a.bytes > a.maxBytes) return { ok: false, motivo: "tamanho" };
  return { ok: true };
}

function msgErro(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Extensão de arquivo a partir do mimetype (default ogg) — só p/ o nome no multipart. */
function extDoMime(mimetype: string): string {
  const mt = (mimetype ?? "").toLowerCase();
  if (mt.startsWith("audio/mpeg")) return "mp3";
  if (mt.startsWith("audio/mp4") || mt.includes("m4a")) return "m4a";
  if (mt.startsWith("audio/wav") || mt.startsWith("audio/x-wav")) return "wav";
  if (mt.startsWith("audio/webm")) return "webm";
  if (mt.startsWith("audio/aac")) return "aac";
  return "ogg";
}

/**
 * Provedor OpenAI (default): 1 POST multipart para /v1/audio/transcriptions.
 * OGG/Opus do WhatsApp é aceito direto (sem ffmpeg). Usa FormData/Blob globais
 * (Node ≥18). validateStatus:()=>true para tratar 4xx/5xx sem throw. Loga só o
 * status — nunca o corpo (que poderia ecoar conteúdo do cliente).
 */
export const transcritorOpenAI: TranscritorProvider = async ({ audio, mimetype, apiKey, model, idiomaHint }) => {
  const env = getEnv();
  const form = new FormData();
  form.append("file", new Blob([audio], { type: mimetype }), `audio.${extDoMime(mimetype)}`);
  form.append("model", model);
  form.append("response_format", "json");
  if (idiomaHint) form.append("language", idiomaHint);

  try {
    const r = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: env.TRANSCRICAO_TIMEOUT_MS,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    });
    if (r.status !== 200) {
      logger.warn("[transcricao] OpenAI respondeu status não-200", { status: r.status });
      return null;
    }
    const texto = typeof (r.data as { text?: unknown })?.text === "string" ? (r.data as { text: string }).text : "";
    return { texto, idioma: idiomaHint };
  } catch (e) {
    logger.warn("[transcricao] OpenAI falhou", { erro: msgErro(e) });
    return null;
  }
};

/** Mapa provider → implementação. `local`/`groq` ficam reservados (fallback p/ openai por ora). */
function escolherProvider(nome: string): TranscritorProvider {
  switch (nome) {
    case "openai":
    default:
      return transcritorOpenAI;
  }
}

/**
 * Orquestrador chamado pelo handler. Aplica flag + guardas + provider e
 * normaliza o resultado. NUNCA lança: qualquer falha (flag off, sem chave, áudio
 * inelegível, provider null/throw, texto vazio) vira null e o caller cai no
 * fallback ("me escreve por texto"). `deps.provider` permite injetar nos testes.
 */
export async function transcreverAudio(
  args: { audio: Buffer; mimetype: string; duracaoSeg?: number },
  deps?: { provider?: TranscritorProvider },
): Promise<ResultadoTranscricao | null> {
  const env = getEnv();
  if (!env.TRANSCRICAO_ENABLED) return null;
  if (!env.TRANSCRICAO_API_KEY) {
    logger.warn("[transcricao] habilitada sem TRANSCRICAO_API_KEY — ignorando áudio");
    return null;
  }

  const elegivel = audioElegivel({
    mimetype: args.mimetype,
    duracaoSeg: args.duracaoSeg,
    bytes: args.audio.length,
    maxSeg: env.TRANSCRICAO_MAX_SEG,
    maxBytes: env.TRANSCRICAO_MAX_BYTES,
  });
  if (!elegivel.ok) {
    logger.warn("[transcricao] áudio inelegível", { motivo: elegivel.motivo, bytes: args.audio.length, duracaoSeg: args.duracaoSeg });
    return null;
  }

  const provider = deps?.provider ?? escolherProvider(env.TRANSCRICAO_PROVIDER);
  let r: ResultadoTranscricao | null;
  try {
    r = await provider({
      audio: args.audio,
      mimetype: args.mimetype,
      duracaoSeg: args.duracaoSeg,
      apiKey: env.TRANSCRICAO_API_KEY,
      model: env.TRANSCRICAO_MODEL,
      idiomaHint: "pt",
    });
  } catch (e) {
    logger.warn("[transcricao] provider lançou", { erro: msgErro(e) });
    return null;
  }

  const texto = (r?.texto ?? "").trim();
  if (!texto) return null;
  return { texto, idioma: r?.idioma, duracaoSeg: args.duracaoSeg };
}
