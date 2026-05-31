/**
 * Testes de `decidirModoBia` — postura por estado (Feature "Bia sempre responde").
 * Função pura, 3 modos: ativo / holding / mudo. A Bia só fica calada em `encerrado`.
 */
import { describe, it, expect } from "vitest";
import { decidirModoBia } from "../src/services/bot.service";

describe("decidirModoBia", () => {
  it("bot_ativo e aguardando_confirmacao_cotacao → ativo", () => {
    expect(decidirModoBia("bot_ativo")).toBe("ativo");
    expect(decidirModoBia("aguardando_confirmacao_cotacao")).toBe("ativo");
  });

  it("estados de cotação/equipe → holding (responde, sem coletar)", () => {
    for (const e of [
      "aguardando_cotacao",
      "cotacao_enviada",
      "aceite_registrado",
      "proposta_transmitida",
    ]) {
      expect(decidirModoBia(e), e).toBe("holding");
    }
  });

  it("humano_assumiu, apolice_emitida e bloqueado_vip → holding (acolhe, nunca cala)", () => {
    expect(decidirModoBia("humano_assumiu")).toBe("holding");
    expect(decidirModoBia("apolice_emitida")).toBe("holding");
    expect(decidirModoBia("bloqueado_vip")).toBe("holding");
  });

  it("encerrado → mudo (nova mensagem reabre como conversa nova)", () => {
    expect(decidirModoBia("encerrado")).toBe("mudo");
  });

  it("estado desconhecido → holding (fail-safe: nunca silêncio acidental)", () => {
    expect(decidirModoBia("estado_que_nao_existe")).toBe("holding");
  });
});
