/**
 * Parsing dos itens de polling do Aggilizador → ResultadoCotacaoItem. PURO.
 * Forma confirmada no HAR de cotação concluída (resultados[].coberturas/parcelamentos).
 */
import { describe, it, expect } from "vitest";
import { mapearResultadoAggilizador, todasRetornaram } from "../src/integrations/aggilizador/aggilizador.resultado";

// Item realista (Allianz "Master") do HAR.
const ALLIANZ = {
  seguradoraTxt: "Allianz",
  seguradora: 5,
  retorno: true,
  retornoErro: false,
  premio: 8547.09,
  premioMensal: 712.2575,
  resultados: [
    {
      principal: true,
      identificacao: "Master",
      premio: 8547.09,
      premioMensal: 712.2575,
      franquia: 4911.01,
      coberturas: {
        tipoPadronizado: "Compreensiva",
        franquiaPadronizado: "50% da Obrigatória",
        assist24hs: "Km Livre",
        carroReserva: "15 Dias",
        vidros: "Vidros, Faróis, Lanternas e Retrovisores.",
      },
      parcelamentos: [
        { parcelas: 1, premioPrimeiraParc: 8547.09, tipoPag: 3 },
        { parcelas: 10, premioPrimeiraParc: 854.709, tipoPag: 1 },
      ],
    },
    { principal: false, identificacao: "Roubo e Furto", premio: 4463.21, parcelamentos: [] },
  ],
};

describe("mapearResultadoAggilizador", () => {
  it("retorno com oferta → cotado, prêmio do plano principal + parcelamento de cartão", () => {
    const r = mapearResultadoAggilizador(ALLIANZ);
    expect(r.seguradora).toBe("Allianz");
    expect(r.status).toBe("cotado");
    expect(r.premio_total).toBe(8547.09);
    // melhor parcelamento de CARTÃO (tipoPag=1): 10x de 854.709.
    expect(r.parcelas).toBe(10);
    expect(r.valor_parcela).toBeCloseTo(854.709, 2);
    expect(r.coberturas_resumo).toMatch(/Compreensiva/);
    expect(r.coberturas_resumo).toMatch(/Carro reserva 15 Dias/);
    expect(r.motivo).toBeUndefined();
  });

  it("retorno:true com premio:0 e resultados:[] → recusado (sem oferta para o perfil)", () => {
    const r = mapearResultadoAggilizador({ seguradoraTxt: "Suíça", retorno: true, retornoErro: false, premio: 0, resultados: [] });
    expect(r.status).toBe("recusado");
    expect(r.motivo).toMatch(/Sem oferta/i);
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

  it("parcelamentos:[] mas premioMensal presente → 12x do mensal (estimativa)", () => {
    const r = mapearResultadoAggilizador({
      seguradoraTxt: "Azul Assinatura",
      retorno: true,
      retornoErro: false,
      premio: 270.44,
      premioMensal: 22.54,
      resultados: [{ principal: true, premio: 270.44, premioMensal: 22.54, parcelamentos: [] }],
    });
    expect(r.status).toBe("cotado");
    expect(r.parcelas).toBe(12);
    expect(r.valor_parcela).toBeCloseTo(22.54, 2);
  });
});

describe("todasRetornaram", () => {
  it("vazio → false (ainda não começou)", () => {
    expect(todasRetornaram([])).toBe(false);
  });
  it("todas com retorno (oferta ou recusa) ou retornoErro → true", () => {
    expect(todasRetornaram([{ retorno: true }, { retornoErro: true }])).toBe(true);
  });
  it("alguma ainda processando → false", () => {
    expect(todasRetornaram([{ retorno: true }, { retorno: false, retornoErro: false }])).toBe(false);
  });
});
