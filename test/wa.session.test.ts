/**
 * Testes do SessionManager: connect() não-bloqueante (abre o socket em
 * background, com guard anti-corrida) e shutdown() (marca canais desconectado).
 * Mocka persistence/baileys/eventHandlers/authState — sem rede nem Baileys real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  buscarCanal: vi.fn(),
  atualizarCanal: vi.fn(async () => {}),
  criarSocketBaileys: vi.fn(),
  registrarHandlers: vi.fn(),
  useSupabaseAuthState: vi.fn(async () => ({ state: {}, saveCreds: async () => {} })),
}));

vi.mock("../src/integrations/whatsapp/persistence", () => ({
  buscarCanal: h.buscarCanal,
  atualizarCanal: h.atualizarCanal,
  lerCanaisParaBootstrap: vi.fn(async () => []),
  registrarMensagemSaida: vi.fn(),
  registrarMensagemSaidaBot: vi.fn(),
  registrarMensagemSaidaBotDocumento: vi.fn(),
}));
vi.mock("../src/integrations/whatsapp/baileys.client", () => ({
  criarSocketBaileys: h.criarSocketBaileys,
}));
vi.mock("../src/integrations/whatsapp/eventHandlers", () => ({
  registrarHandlers: h.registrarHandlers,
}));
vi.mock("../src/integrations/whatsapp/supabaseAuthState", () => ({
  useSupabaseAuthState: h.useSupabaseAuthState,
}));

import { sessionManager } from "../src/integrations/whatsapp/sessionManager";

beforeEach(() => {
  h.buscarCanal.mockReset();
  h.atualizarCanal.mockReset().mockResolvedValue(undefined);
  h.criarSocketBaileys.mockReset().mockResolvedValue({ end: vi.fn() });
  h.registrarHandlers.mockReset();
  h.useSupabaseAuthState
    .mockReset()
    .mockResolvedValue({ state: {}, saveCreds: async () => {} });
});

describe("connect() não-bloqueante", () => {
  it("retorna {conectando} de imediato e abre o socket em background", async () => {
    h.buscarCanal.mockResolvedValue({ id: "c-a", apelido: "A", provider: "baileys", status: "desconectado" });

    const r = await sessionManager.connect("c-a");
    expect(r).toEqual({ status: "conectando", jaAtivo: false });
    expect(h.atualizarCanal).toHaveBeenCalledWith("c-a", { status: "conectando" });

    await vi.waitFor(() => expect(h.registrarHandlers).toHaveBeenCalled());
    expect(h.criarSocketBaileys).toHaveBeenCalledTimes(1);

    // Socket já vivo → 2ª chamada é no-op (ja_ativo).
    const r2 = await sessionManager.connect("c-a");
    expect(r2).toEqual({ status: "ja_ativo", jaAtivo: true });
  });

  it("connect concorrente não recria o socket (guard 'conectando')", async () => {
    h.buscarCanal.mockResolvedValue({ id: "c-b", apelido: "B", provider: "baileys", status: "desconectado" });
    // Trava o abrirSocket em useSupabaseAuthState para simular abertura em curso.
    let liberar!: () => void;
    h.useSupabaseAuthState.mockImplementationOnce(
      () => new Promise((res) => { liberar = () => res({ state: {}, saveCreds: async () => {} }); }),
    );

    const r1 = await sessionManager.connect("c-b");
    expect(r1.status).toBe("conectando");
    const r2 = await sessionManager.connect("c-b");
    expect(r2.status).toBe("conectando");
    // Só uma abertura em andamento.
    expect(h.useSupabaseAuthState).toHaveBeenCalledTimes(1);
    expect(h.criarSocketBaileys).not.toHaveBeenCalled();

    liberar();
    await vi.waitFor(() => expect(h.registrarHandlers).toHaveBeenCalled());
  });
});

describe("shutdown()", () => {
  it("encerra o socket, marca desconectado e não reconecta", async () => {
    h.buscarCanal.mockResolvedValue({ id: "c-s", apelido: "S", provider: "baileys", status: "desconectado" });
    const sockEnd = vi.fn();
    h.criarSocketBaileys.mockResolvedValue({ end: sockEnd });

    await sessionManager.connect("c-s");
    await vi.waitFor(() => expect(h.registrarHandlers).toHaveBeenCalled());

    h.atualizarCanal.mockClear();
    await sessionManager.shutdown("hibernate");

    expect(sockEnd).toHaveBeenCalled();
    expect(h.atualizarCanal).toHaveBeenCalledWith(
      "c-s",
      expect.objectContaining({ status: "desconectado", last_disconnect_reason: "hibernate" }),
    );
  });
});
