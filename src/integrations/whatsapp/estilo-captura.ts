/**
 * Captura CONTÍNUA do estilo REAL do operador no WhatsApp.
 *
 * Problema: o jeito autêntico de o operador escrever está nas mensagens que ELE
 * digita no WhatsApp (celular/Web), não no histórico do banco (que pode ser
 * sintético/IA). Toda mensagem `fromMe` é hoje ignorada no eventHandlers. Aqui,
 * quando ESTILO_CAPTURA_ENABLED, capturamos APENAS as `fromMe` digitadas por um
 * HUMANO — isto é, cujo id NÃO foi enviado pela própria plataforma (Bia/operador
 * via composer). O sinal é confiável: todo envio nosso persiste o id em
 * `mensagens.twilio_message_sid`. Guardamos também um Set em memória dos ids que
 * acabamos de enviar, para fechar a janela de corrida antes do INSERT comitar.
 *
 * O texto é REDIGIDO de PII antes de gravar no corpus `operador_estilo_corpus`
 * (append-only). É best-effort: qualquer erro é engolido — NUNCA afeta o pipeline
 * de mensagens. Só captura, nunca age. INERTE enquanto a flag estiver off.
 */
import { getSupabaseAdmin } from "./supabase";
import { redigirPII } from "../../services/aprendizado.service";
import { logger } from "../../utils/logger";

const MIN_CORPO = 2;
const MAX_CORPO = 500;

// Ids que ESTA instância enviou (Bia/operador). LRU simples por tamanho: fecha a
// corrida "eco fromMe chega antes do INSERT comitar". O check no banco é o backstop
// definitivo (cobre reinício do processo). Cap pequeno: só precisamos do passado recente.
const MAX_IDS = 5000;
const idsEnviados = new Set<string>();

/** Marca um id como "enviado por nós" (chamar logo após sock.sendMessage resolver). */
export function marcarEnvioProprio(messageId: string | null | undefined): void {
  if (!messageId) return;
  if (idsEnviados.size >= MAX_IDS) {
    // Evict do mais antigo (ordem de inserção do Set).
    const primeiro = idsEnviados.values().next().value as string | undefined;
    if (primeiro) idsEnviados.delete(primeiro);
  }
  idsEnviados.add(messageId);
}

/** true se o id foi enviado por nós (memória OU banco) → NÃO é digitação humana. */
async function ehEnvioProprio(messageId: string): Promise<boolean> {
  if (idsEnviados.has(messageId)) return true;
  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("mensagens")
    .select("id")
    .eq("twilio_message_sid", messageId)
    .limit(1)
    .maybeSingle();
  return !!data;
}

export interface CapturaInput {
  canalId: string;
  messageId: string | null;
  texto: string;
  enviadaEm?: Date;
}

/**
 * Captura uma mensagem `fromMe` SE for digitação humana (não nossa). Best-effort:
 * loga e retorna em qualquer erro — jamais propaga. Pré-condição: chamado só quando
 * ESTILO_CAPTURA_ENABLED (gate no eventHandlers) e a mensagem é texto.
 */
export async function capturarMensagemOperador(input: CapturaInput): Promise<void> {
  try {
    const corpo = redigirPII((input.texto ?? "").trim()).slice(0, MAX_CORPO).trim();
    if (corpo.length < MIN_CORPO) return;
    // Sem id confiável não dá para distinguir de um envio nosso → não captura
    // (preferimos perder a amostra a poluir o corpus com texto da Bia).
    if (!input.messageId) return;
    if (await ehEnvioProprio(input.messageId)) return;

    const sb = getSupabaseAdmin();
    const { error } = await sb.from("operador_estilo_corpus").insert({
      canal_id: input.canalId,
      corpo,
      enviada_em: (input.enviadaEm ?? new Date()).toISOString(),
    });
    if (error) {
      logger.warn("[estilo.captura] insert falhou (ignorado)", { erro: error.message });
    }
  } catch (e) {
    logger.warn("[estilo.captura] exceção (ignorada)", { erro: (e as Error).message });
  }
}

/** Apenas para testes: limpa o Set em memória. */
export function _resetIdsEnviados(): void {
  idsEnviados.clear();
}
