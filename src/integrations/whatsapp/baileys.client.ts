/**
 * Fábrica isolada do socket Baileys.
 *
 * Mantemos as opções padrão centralizadas aqui (browser id, printQR no
 * terminal off, sem sync full history para não estourar memória). Tudo que
 * varia por canal (auth state) vem como argumento.
 *
 * `fetchLatestBaileysVersion` consulta https://web.whatsapp.com/check-update
 * e devolve a versão de protocolo que o WA Web aceita HOJE. Sem isso, o socket
 * envia o app version hardcoded da lib (ex.: 2.3000.x), e o WA rejeita com
 * `reasonCode: 405` (`connectionFailure`) em loop infinito. Cacheamos a versão
 * por 1h para não bater no endpoint a cada pareamento.
 */
import {
  makeWASocket,
  Browsers,
  fetchLatestBaileysVersion,
  type AuthenticationState,
  type WASocket,
} from "@whiskeysockets/baileys";
import { logger } from "../../utils/logger";

export interface OpcoesSocket {
  state: AuthenticationState;
  apelidoCanal: string;
}

let cacheVersion: { version: [number, number, number]; expiraEm: number } | null = null;
const TTL_VERSION_MS = 60 * 60 * 1000; // 1 hora
const FETCH_VERSION_TIMEOUT_MS = 6_000;
/** Versão hardcoded de último recurso — manter alinhada à lib instalada. */
const FALLBACK_VERSION: [number, number, number] = [2, 3000, 0];

/**
 * Promise.race com timeout portável (não depende de AbortSignal no fetch da
 * lib). Limpa o timer no finally para não vazar. A promise que escapar continua
 * em background sem efeito relevante (no máximo uma escrita tardia no cache).
 */
export async function comTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`timeout_${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer!);
  }
}

async function versionAtual(): Promise<[number, number, number]> {
  if (cacheVersion && Date.now() < cacheVersion.expiraEm) {
    return cacheVersion.version;
  }
  try {
    const { version, isLatest } = await comTimeout(
      fetchLatestBaileysVersion(),
      FETCH_VERSION_TIMEOUT_MS,
    );
    cacheVersion = { version, expiraEm: Date.now() + TTL_VERSION_MS };
    logger.info("[wa.client] versão WA atualizada", { version, isLatest });
    return version;
  } catch (e) {
    logger.warn("[wa.client] fetchLatestBaileysVersion falhou; usando cache/fallback", {
      erro: (e as Error).message,
    });
    // Prefere o cache expirado (mais próximo da realidade) ao hardcoded.
    return cacheVersion?.version ?? FALLBACK_VERSION;
  }
}

export async function criarSocketBaileys(opcoes: OpcoesSocket): Promise<WASocket> {
  const version = await versionAtual();
  return makeWASocket({
    version,
    auth: opcoes.state,
    printQRInTerminal: false,
    browser: Browsers.macOS(`Piero Portal — ${opcoes.apelidoCanal}`),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
}
