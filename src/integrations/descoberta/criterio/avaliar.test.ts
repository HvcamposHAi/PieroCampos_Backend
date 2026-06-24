import { describe, it, expect } from "vitest";
import { avaliarCriterio, criterioPadrao } from "./avaliar";

describe("avaliarCriterio", () => {
  it("apólice: só atinge com numeroApolice + PDF", () => {
    const c = criterioPadrao("apolice");
    expect(avaliarCriterio(c, { numeroApolice: "AP-123", pdfBytes: 5000 }).atingido).toBe(true);
    expect(avaliarCriterio(c, { numeroApolice: "AP-123", pdfBytes: 0 }).atingido).toBe(false);
    expect(avaliarCriterio(c, { numeroApolice: "", pdfBytes: 5000 }).atingido).toBe(false);
    expect(avaliarCriterio(c, {}).motivo).toMatch(/numeroApolice|pdf/);
  });

  it("cotação: atinge com ≥1 item cotado", () => {
    const c = criterioPadrao("cotacao");
    expect(avaliarCriterio(c, { resultados: [{ seguradora: "X", premio_total: 100, parcelas: 1, valor_parcela: 0, coberturas_resumo: "", status: "cotado" }] }).atingido).toBe(true);
    expect(avaliarCriterio(c, { resultados: [{ seguradora: "X", premio_total: 0, parcelas: 1, valor_parcela: 0, coberturas_resumo: "", status: "recusado" }] }).atingido).toBe(false);
  });

  it("validar_estrutura: atinge só com veredito 'suporta'", () => {
    const c = criterioPadrao("validar_estrutura");
    expect(avaliarCriterio(c, { veredito: "suporta" }).atingido).toBe(true);
    expect(avaliarCriterio(c, { veredito: "parcial" }).atingido).toBe(false);
  });

  it("consulta: exige campos-alvo", () => {
    expect(avaliarCriterio({ objetivo: "consulta", exige: ["status"] }, { campos: { status: "ok" } }).atingido).toBe(true);
    expect(avaliarCriterio({ objetivo: "consulta", exige: ["status"] }, { campos: {} }).atingido).toBe(false);
  });
});
