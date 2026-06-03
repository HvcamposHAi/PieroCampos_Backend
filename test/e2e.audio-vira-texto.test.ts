/**
 * E2E: nota de voz vira texto (fakes; sem rede). Exercita o handler real
 * `registrarHandlers` → callback de `messages.upsert` com uma mensagem de
 * `audioMessage`, e verifica que o transcript segue o MESMO caminho do texto
 * (registrarMensagemEntrada → processarMensagem). Cobre sucesso, transcrição
 * vazia (fallback) e duplicada.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  downloadMediaMessage: vi.fn(),
  transcreverAudio: vi.fn(),
  subirAudioWhatsapp: vi.fn(),
  processarMensagem: vi.fn(),
  registrarMensagemEntrada: vi.fn(),
  enviarTextoBot: vi.fn(),
}));

vi.mock("@whiskeysockets/baileys", () => ({
  downloadMediaMessage: h.downloadMediaMessage,
  isLidUser: () => false,
  DisconnectReason: { loggedOut: 401, connectionReplaced: 440, timedOut: 408 },
}));
vi.mock("../src/lib/transcricao", () => ({ transcreverAudio: h.transcreverAudio }));
vi.mock("../src/integrations/whatsapp/audio-storage", () => ({ subirAudioWhatsapp: h.subirAudioWhatsapp }));
vi.mock("../src/services/bot.service", () => ({
  processarMensagem: h.processarMensagem,
  processarFormularioRecebido: vi.fn(),
}));
vi.mock("../src/services/handoff.service", () => ({ montarMensagemAlerta: () => "alerta" }));
vi.mock("../src/integrations/whatsapp/conversas.dados", () => ({ enfileirarCampoForcado: vi.fn() }));
vi.mock("../src/integrations/whatsapp/supabaseAuthState", () => ({ apagarAuthState: vi.fn() }));
vi.mock("../src/integrations/whatsapp/persistence", () => ({
  registrarMensagemEntrada: h.registrarMensagemEntrada,
  atualizarCanal: vi.fn(),
  buscarCanal: vi.fn(),
  jidParaE164: (j: string) => j.split("@")[0],
  lerAlertaConfigCanal: vi.fn(async () => ({ ativo: false, numero: null })),
  registrarStatusEntrega: vi.fn(),
}));
vi.mock("../src/integrations/whatsapp/sessionManager", () => ({
  sessionManager: { enviarTextoBot: h.enviarTextoBot, enviarDocumentoBot: vi.fn(), enviarAlerta: vi.fn() },
}));

import { registrarHandlers } from "../src/integrations/whatsapp/eventHandlers";
import { _resetEnvCache } from "../src/config/env";

/** Fake do socket Baileys: captura os handlers por nome de evento. */
function fakeSock() {
  const handlers: Record<string, (arg: unknown) => unknown> = {};
  return {
    handlers,
    ev: { on: (ev: string, fn: (arg: unknown) => unknown) => (handlers[ev] = fn) },
    updateMediaMessage: vi.fn(),
    user: { id: "5541@s.whatsapp.net", name: "Linha" },
  };
}

function msgAudio() {
  return {
    key: { remoteJid: "554199@s.whatsapp.net", fromMe: false, id: "MSGID1" },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: "Cliente",
    message: { audioMessage: { ptt: true, mimetype: "audio/ogg; codecs=opus", seconds: 8 } },
  };
}

async function dispararUpsert() {
  const sock = fakeSock();
  registrarHandlers("canal1", sock as never, async () => {}, {});
  await sock.handlers["messages.upsert"]!({ messages: [msgAudio()], type: "notify" });
}

beforeEach(() => {
  process.env.WA_ENABLED = "false";
  process.env.BIA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "false";
  process.env.TRANSCRICAO_ENABLED = "true";
  process.env.TRANSCRICAO_API_KEY = "test-key";
  _resetEnvCache();
  Object.values(h).forEach((m) => m.mockReset());
  h.enviarTextoBot.mockResolvedValue(undefined);
  h.downloadMediaMessage.mockResolvedValue(Buffer.from("ogg-bytes"));
  h.subirAudioWhatsapp.mockResolvedValue({ path: "MSGID1.ogg" });
  h.registrarMensagemEntrada.mockResolvedValue({ conversaId: "conv1", clienteId: "cli1", estado: "bot_ativo", duplicada: false });
});

describe("E2E — áudio vira texto", () => {
  it("sucesso: baixa, sobe, transcreve e aciona a Bia com o transcript", async () => {
    h.transcreverAudio.mockResolvedValue({ texto: "quero seguro auto", duracaoSeg: 8 });
    await dispararUpsert();

    expect(h.downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(h.subirAudioWhatsapp).toHaveBeenCalledWith(
      expect.objectContaining({ providerMsgId: "MSGID1", mimetype: "audio/ogg; codecs=opus" }),
    );
    expect(h.transcreverAudio).toHaveBeenCalledWith(
      expect.objectContaining({ mimetype: "audio/ogg; codecs=opus", duracaoSeg: 8 }),
    );
    expect(h.registrarMensagemEntrada).toHaveBeenCalledWith(
      expect.objectContaining({ texto: "quero seguro auto", midiaTipo: "audio", midiaUrl: "MSGID1.ogg" }),
    );
    expect(h.processarMensagem).toHaveBeenCalledWith(
      expect.objectContaining({ textoCliente: "quero seguro auto", conversaId: "conv1" }),
    );
  });

  it("transcrição vazia → persiste placeholder, NÃO chama a Bia e pede texto", async () => {
    h.transcreverAudio.mockResolvedValue(null);
    await dispararUpsert();

    expect(h.registrarMensagemEntrada).toHaveBeenCalledWith(
      expect.objectContaining({ texto: "[áudio recebido]", midiaTipo: "audio" }),
    );
    expect(h.processarMensagem).not.toHaveBeenCalled();
    expect(h.enviarTextoBot).toHaveBeenCalledWith(
      expect.objectContaining({ texto: expect.stringContaining("texto") }),
    );
  });

  it("mensagem duplicada → não reprocessa (sem Bia)", async () => {
    h.transcreverAudio.mockResolvedValue({ texto: "oi" });
    h.registrarMensagemEntrada.mockResolvedValue({ conversaId: "conv1", clienteId: "cli1", estado: "bot_ativo", duplicada: true });
    await dispararUpsert();

    expect(h.processarMensagem).not.toHaveBeenCalled();
  });
});
