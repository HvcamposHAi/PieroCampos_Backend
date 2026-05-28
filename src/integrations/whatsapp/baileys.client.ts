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

async function versionAtual(): Promise<[number, number, number]> {
  if (cacheVersion && Date.now() < cacheVersion.expiraEm) {
    return cacheVersion.version;
  }
  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    cacheVersion = { version, expiraEm: Date.now() + TTL_VERSION_MS };
    logger.info("[wa.client] versão WA atualizada", { version, isLatest });
    return version;
  } catch (e) {
    logger.warn("[wa.client] fetchLatestBaileysVersion falhou; usando default da lib", {
      erro: (e as Error).message,
    });
    // Fallback: deixa o makeWASocket usar a versão hardcoded.
    return [2, 3000, 0];
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
