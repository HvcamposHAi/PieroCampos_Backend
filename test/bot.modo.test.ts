/**
 * Testes de `decidirModoBia` — postura por estado (Feature "Bia sempre responde").
 * Função pura: cobre os 9 estados do enum sem mocks.
 */
import { describe, it, expect } from "vitest";
import { decidirModoBia } from "../src/services/bot.service";

describe("decidirModoBia", () => {
  it("bot_ativo → ativo", () => {
    expect(decidirModoBia("bot_ativo")).toBe("ativo");
  });

  it("aguardando_confirmacao_cotacao → ativo (Bia pede a decisão de cotar)", () => {
    expect(decidirModoBia("aguardando_confirmacao_cotacao")).toBe("ativo");
  });

  it("estados de equipe trabalhando → espera_equipe", () => {
    for (const e of [
      "aguardando_cotacao",
      "cotacao_enviada",
      "aceite_registrado",
      "proposta_transmitida",
    ]) {
      expect(decidirModoBia(e), e).toBe("espera_equipe");
    }
  });

  it("humano_assumiu e apolice_emitida → holding_humano (acolhe, não fica calada)", () => {
    expect(decidirModoBia("humano_assumiu")).toBe("holding_humano");
    expect(decidirModoBia("apolice_emitida")).toBe("holding_humano");
  });

  it("bloqueado_vip e encerrado → mudo", () => {
    expect(decidirModoBia("bloqueado_vip")).toBe("mudo");
    expect(decidirModoBia("encerrado")).toBe("mudo");
  });
});
