/**
 * Testes dos guards de `messages.upsert`: processar backlog offline ("append")
 * além do ao vivo ("notify"), e a janela de idade do backlog. Funções puras.
 */
import { describe, it, expect } from "vitest";
import {
  deveProcessarUpsert,
  dentroDaJanelaBacklog,
} from "../src/integrations/whatsapp/eventHandlers";

describe("deveProcessarUpsert", () => {
  it("aceita notify (ao vivo) e append (backlog offline)", () => {
    expect(deveProcessarUpsert("notify")).toBe(true);
    expect(deveProcessarUpsert("append")).toBe(true);
  });

  it("rejeita prepend (sync de histórico) e tipos vazios/desconhecidos", () => {
    expect(deveProcessarUpsert("prepend")).toBe(false);
    expect(deveProcessarUpsert("")).toBe(false);
    expect(deveProcessarUpsert("qualquer")).toBe(false);
  });
});

describe("dentroDaJanelaBacklog", () => {
  const agora = 1_700_000_000_000; // ms fixos (sem Date.now no teste)

  it("mensagem recente (agora) → dentro da janela", () => {
    expect(dentroDaJanelaBacklog(Math.floor(agora / 1000), agora)).toBe(true);
  });

  it("mensagem de 25h atrás → fora da janela de 24h", () => {
    const ts25h = Math.floor((agora - 25 * 3600 * 1000) / 1000);
    expect(dentroDaJanelaBacklog(ts25h, agora)).toBe(false);
  });

  it("sem timestamp → processa (não descarta por falta de dado)", () => {
    expect(dentroDaJanelaBacklog(null, agora)).toBe(true);
    expect(dentroDaJanelaBacklog(undefined, agora)).toBe(true);
  });

  it("respeita maxIdadeMs customizado", () => {
    const ts2h = Math.floor((agora - 2 * 3600 * 1000) / 1000);
    expect(dentroDaJanelaBacklog(ts2h, agora, 3600 * 1000)).toBe(false); // janela 1h
    expect(dentroDaJanelaBacklog(ts2h, agora, 3 * 3600 * 1000)).toBe(true); // janela 3h
  });
});
