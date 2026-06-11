/**
 * Parsing dos itens de polling do Aggilizador → ResultadoCotacaoItem. PURO.
 */
import { describe, it, expect } from "vitest";
import { mapearResultadoAggilizador, todasRetornaram } from "../src/integrations/aggilizador/aggilizador.resultado";

describe("mapearResultadoAggilizador", () => {
  it("retorno com prêmio > 0 → cotado (1x do prêmio sem tabela de parcelas)", () => {
    const r = mapearResultadoAggilizador({ seguradoraTxt: "Aliro", retorno: true, retornoErro: false, premio: 1900 });
    expect(r.seguradora).toBe("Aliro");
    expect(r.status).toBe("cotado");
    expect(r.premio_total).toBe(1900);
    expect(r.parcelas).toBe(1);
    expect(r.valor_parcela).toBe(1900);
    expect(r.motivo).toBeUndefined();
  });

  it("tabela de parcelamento (objeto) → maior nº de parcelas e seu valor", () => {
    const r = mapearResultadoAggilizador({
      seguradoraTxt: "Allianz",
      retorno: true,
      retornoErro: false,
      premio: 2000,
      parcelamento: { "1": 2000, "10": 200 },
    });
    expect(r.parcelas).toBe(10);
    expect(r.valor_parcela).toBe(200);
  });

  it("retornoErro → recusado, com motivo limpo (sem HTML)", () => {
    const r = mapearResultadoAggilizador({
      seguradoraTxt: "Sancor",
      retorno: true,
      retornoErro: true,
      premio: 0,
      mensagem: "<b>Veículo não aceito</b>",
    });
    expect(r.status).toBe("recusado");
    expect(r.motivo).toBe("Veículo não aceito");
  });

  it("ainda processando → status 'processando'", () => {
    const r = mapearResultadoAggilizador({ seguradoraTxt: "Yelum", retorno: false, retornoErro: false, premio: 0 });
    expect(r.status).toBe("processando");
  });
});

describe("todasRetornaram", () => {
  it("vazio → false (ainda não começou)", () => {
    expect(todasRetornaram([])).toBe(false);
  });
  it("todas com retorno ou retornoErro → true", () => {
    expect(todasRetornaram([{ retorno: true }, { retornoErro: true }])).toBe(true);
  });
  it("alguma ainda processando → false", () => {
    expect(todasRetornaram([{ retorno: true }, { retorno: false, retornoErro: false }])).toBe(false);
  });
});
