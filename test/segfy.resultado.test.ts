/**
 * Testa o parser dos resultados do multicálculo (evento RESULT do Socket.IO),
 * usando o formato REAL capturado em 30/05/2026.
 */
import { describe, it, expect } from "vitest";
import { mapearResultadoParaItem } from "../src/integrations/segfy/segfy.resultado";

// Recorte real de um evento RESULT (seguradora ezze).
const RESULT_EZZE = {
  company: { id: "2ec6edf8", name: "ezze", business: "car", full_name: "Ezze" },
  quotation: "698e61f9-9e43-4902-84bb-eedecaf9b385",
  commission: 15,
  premium: 4013.53,
  franchise: 0,
  status: "additional_product",
  messages: "Sucesso",
  company_coverages: {
    coverage_type: "Terceiros",
    assistence: "Assistencia - Passeio Essencial 500km",
    rental_car: "Carro Reserva - Plano Essencial 7 dias",
    body_injuries: 200000,
    material_damage: 200000,
  },
  installments: {
    "Cartão de Crédito": { "1": 4013.53, "2": 2006.77, "10": 401.35 },
    Boleto: { "1": 4013.53, "5": 802.71 },
  },
};

describe("mapearResultadoParaItem", () => {
  it("mapeia premium, seguradora e o melhor parcelamento (Cartão, max parcelas)", () => {
    const item = mapearResultadoParaItem(RESULT_EZZE);
    expect(item.seguradora).toBe("Ezze");
    expect(item.premio_total).toBe(4013.53);
    expect(item.parcelas).toBe(10);
    expect(item.valor_parcela).toBe(401.35);
    expect(item.status).toBe("cotado"); // premium>0 + status additional_product
    expect(item.coberturas_resumo).toContain("Terceiros");
  });

  it("marca como recusado quando não há prêmio", () => {
    const item = mapearResultadoParaItem({ company: { name: "x" }, premium: 0, status: "error" });
    expect(item.status).toBe("error");
    expect(item.premio_total).toBe(0);
    expect(item.parcelas).toBe(1);
  });

  it("cai para Boleto quando não há Cartão de Crédito", () => {
    const item = mapearResultadoParaItem({
      company: { name: "mapfre" },
      premium: 3000,
      installments: { Boleto: { "1": 3000, "3": 1000 } },
    });
    expect(item.seguradora).toBe("mapfre");
    expect(item.parcelas).toBe(3);
    expect(item.valor_parcela).toBe(1000);
  });
});
