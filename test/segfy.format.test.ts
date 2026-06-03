import { describe, it, expect } from "vitest";
import {
  formatarMoedaBR,
  normalizarValorMonetarioBR,
  formatarComparativoParaWhatsApp,
  formatarOpcaoUnicaParaWhatsApp,
} from "../src/integrations/segfy/segfy.format";
import type { ResultadoCotacaoItem } from "../src/integrations/segfy/segfy.types";

function item(over: Partial<ResultadoCotacaoItem>): ResultadoCotacaoItem {
  return {
    seguradora: "X",
    premio_total: 1000,
    parcelas: 1,
    valor_parcela: 1000,
    coberturas_resumo: "cobertura",
    status: "cotado",
    ...over,
  };
}

describe("formatarMoedaBR", () => {
  it("formata com duas casas e separador pt-BR", () => {
    expect(formatarMoedaBR(1234.5)).toBe("1.234,50");
    expect(formatarMoedaBR(0)).toBe("0,00");
  });
});

describe("normalizarValorMonetarioBR", () => {
  it("interpreta formato pt-BR com R$ e milhar", () => {
    expect(normalizarValorMonetarioBR("R$ 1.234,56")).toBeCloseTo(1234.56, 2);
  });
  it("interpreta vírgula como decimal", () => {
    expect(normalizarValorMonetarioBR("1234,56")).toBeCloseTo(1234.56, 2);
  });
  it("interpreta ponto como decimal quando não há vírgula", () => {
    expect(normalizarValorMonetarioBR("1234.56")).toBeCloseTo(1234.56, 2);
  });
  it("retorna NaN para texto sem dígitos", () => {
    expect(Number.isNaN(normalizarValorMonetarioBR("indisponível"))).toBe(true);
  });
});

describe("formatarComparativoParaWhatsApp", () => {
  it("ordena por menor prêmio e mostra no máximo 3 (top 3)", () => {
    const resultados = [
      item({ seguradora: "C", premio_total: 3000 }),
      item({ seguradora: "A", premio_total: 1000 }),
      item({ seguradora: "B", premio_total: 2000 }),
      item({ seguradora: "D", premio_total: 4000 }),
    ];
    const msg = formatarComparativoParaWhatsApp(resultados, "João");
    expect(msg).toContain("Olá João");
    // A primeira citada deve ser a mais barata (A); D (4ª) não aparece.
    expect(msg.indexOf("*A*")).toBeLessThan(msg.indexOf("*B*"));
    expect(msg.indexOf("*B*")).toBeLessThan(msg.indexOf("*C*"));
    expect(msg).not.toContain("*D*");
    expect(msg).toContain("🥇");
  });

  it("ignora resultados que não estão 'cotado'", () => {
    const resultados = [
      item({ seguradora: "Recusada", premio_total: 10, status: "recusado" }),
      item({ seguradora: "Valida", premio_total: 500, status: "cotado" }),
    ];
    const msg = formatarComparativoParaWhatsApp(resultados, "Maria");
    expect(msg).toContain("*Valida*");
    expect(msg).not.toContain("*Recusada*");
  });

  it("mensagem de fallback quando não há cotações válidas", () => {
    const msg = formatarComparativoParaWhatsApp([item({ status: "recusado" })], "Ana");
    expect(msg).toContain("Ana");
    expect(msg.toLowerCase()).toContain("não conseguimos cotações");
  });
});

describe("formatarOpcaoUnicaParaWhatsApp", () => {
  it("monta UMA opção (sem medalhas/top-3) e pede confirmação", () => {
    const txt = formatarOpcaoUnicaParaWhatsApp(
      item({ seguradora: "Aliro", premio_total: 4304.67, parcelas: 7, valor_parcela: 614.95, coberturas_resumo: "PLANO G" }),
      "Camilly",
    );
    expect(txt).toContain("Camilly");
    expect(txt).toContain("Aliro");
    expect(txt).toContain("4.304,67");
    expect(txt).toContain("7x de R$ 614,95");
    expect(txt).toContain("PLANO G");
    // Não é o comparativo: nada de "número (1, 2 ou 3)" nem medalhas.
    expect(txt).not.toContain("🥇");
    expect(txt).not.toContain("1, 2 ou 3");
  });
});
