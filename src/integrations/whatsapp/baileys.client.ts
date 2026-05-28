/**
 * Fábrica isolada do socket Baileys.
 *
 * Mantemos as opções padrão centralizadas aqui (browser id, printQR no
 * terminal off, sem sync full history para não estourar memória). Tudo que
 * varia por canal (auth state) vem como argumento.
 */
import { makeWASocket, Browsers, type AuthenticationState, type WASocket } from "@whiskeysockets/baileys";

export interface OpcoesSocket {
  state: AuthenticationState;
  apelidoCanal: string;
}

export function criarSocketBaileys(opcoes: OpcoesSocket): WASocket {
  return makeWASocket({
    auth: opcoes.state,
    printQRInTerminal: false,
    browser: Browsers.macOS(`Piero Portal — ${opcoes.apelidoCanal}`),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
}
