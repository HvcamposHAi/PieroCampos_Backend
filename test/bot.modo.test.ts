/**
 * Testes de `decidirModoBia` — postura por estado (Feature "Bia sempre responde").
 * Função pura, 3 modos: ativo / holding / mudo. A Bia fica calada em `encerrado`
 * e em `humano_assumiu` SÓ quando há operador dono (clicou "Assumir"); sem dono
 * (handoff automático) segue em holding para não deixar o cliente no vácuo.
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

  it("apolice_emitida e bloqueado_vip → holding (acolhe, nunca cala)", () => {
    expect(decidirModoBia("apolice_emitida")).toBe("holding");
    expect(decidirModoBia("bloqueado_vip")).toBe("holding");
  });

  it("humano_assumiu SEM dono → holding (handoff automático; Bia ainda acolhe)", () => {
    expect(decidirModoBia("humano_assumiu")).toBe("holding");
    expect(decidirModoBia("humano_assumiu", null)).toBe("holding");
  });

  it("humano_assumiu COM dono → mudo (operador assumiu; Bia não fala por cima)", () => {
    expect(decidirModoBia("humano_assumiu", "op_123")).toBe("mudo");
  });

  it("encerrado → mudo (nova mensagem reabre como conversa nova)", () => {
    expect(decidirModoBia("encerrado")).toBe("mudo");
  });

  it("estado desconhecido → holding (fail-safe: nunca silêncio acidental)", () => {
    expect(decidirModoBia("estado_que_nao_existe")).toBe("holding");
  });
});
