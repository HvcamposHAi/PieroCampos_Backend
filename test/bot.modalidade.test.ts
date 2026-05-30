/**
 * Testes de `deveOferecerModalidade` — o gate "1 a 1 ou formulário".
 * Função pura. Só renovacao/seguro_novo, antes da coleta, sem modalidade prévia.
 */
import { describe, it, expect } from "vitest";
import { deveOferecerModalidade } from "../src/services/bot.service";

describe("deveOferecerModalidade", () => {
  it("renovacao, sem dados e sem modalidade → true", () => {
    expect(
      deveOferecerModalidade({ categoria: "renovacao", dadosBot: {}, dadosColetados: {} }),
    ).toBe(true);
  });

  it("seguro_novo, sem dados e sem modalidade → true", () => {
    expect(
      deveOferecerModalidade({ categoria: "seguro_novo", dadosBot: {}, dadosColetados: {} }),
    ).toBe(true);
  });

  it("endosso / nao_renovado → false (roteiros curtos, sempre 1 a 1)", () => {
    expect(deveOferecerModalidade({ categoria: "endosso", dadosBot: {}, dadosColetados: {} })).toBe(false);
    expect(deveOferecerModalidade({ categoria: "nao_renovado", dadosBot: {}, dadosColetados: {} })).toBe(false);
  });

  it("categoria nula/duvida → false", () => {
    expect(deveOferecerModalidade({ categoria: null, dadosBot: {}, dadosColetados: {} })).toBe(false);
    expect(deveOferecerModalidade({ categoria: "duvida", dadosBot: {}, dadosColetados: {} })).toBe(false);
  });

  it("modalidade já escolhida → false (não repergunta)", () => {
    expect(
      deveOferecerModalidade({
        categoria: "renovacao",
        dadosBot: { modalidade: "um_a_um" },
        dadosColetados: {},
      }),
    ).toBe(false);
  });

  it("coleta já iniciada (dados_coletados não vazio) → false", () => {
    expect(
      deveOferecerModalidade({
        categoria: "renovacao",
        dadosBot: {},
        dadosColetados: { segurado: "João" },
      }),
    ).toBe(false);
  });
});
