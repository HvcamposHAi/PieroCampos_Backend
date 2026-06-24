import { describe, it, expect } from "vitest";
import { construirAteObjetivo } from "./builder.loop";
import type { AdapterSpec, CasoTeste } from "../descoberta.types";
import type { ResultadoObjetivo } from "../criterio/avaliar";

const specBase: AdapterSpec = { sistema: "x", ramo: "auto", operacao: "apolice", objetivo: "apolice", versao: 1, entradaObrigatoria: [], passos: [] };
const caso: CasoTeste = { propostaTeste: "PROP-1", confirmaEmissaoReal: true };

describe("construirAteObjetivo", () => {
  it("converge: falha 2x e atinge na 3ª → validado", async () => {
    let n = 0;
    const r = await construirAteObjetivo(specBase, caso, {
      runner: async (): Promise<ResultadoObjetivo> => {
        n++;
        return n < 3 ? { numeroApolice: null, pdfBytes: 0 } : { numeroApolice: "AP-9", pdfBytes: 4096 };
      },
      refino: async (spec) => ({ ...spec, versao: spec.versao + 1 }), // refino sempre disponível
      maxIteracoes: 5,
    });
    expect(r.status).toBe("validado");
    expect(r.iteracoes).toBe(3);
    expect(r.historico.filter((h) => h.refinou).length).toBe(2);
  });

  it("sem refino possível após falha → requer_humano", async () => {
    const r = await construirAteObjetivo(specBase, caso, {
      runner: async () => ({ numeroApolice: null, pdfBytes: 0 }),
      refino: async () => null,
      maxIteracoes: 5,
    });
    expect(r.status).toBe("requer_humano");
    expect(r.iteracoes).toBe(1);
  });

  it("estoura maxIteracoes refinando sem convergir → requer_humano", async () => {
    const r = await construirAteObjetivo(specBase, caso, {
      runner: async () => ({ numeroApolice: null, pdfBytes: 0 }),
      refino: async (spec) => ({ ...spec }),
      maxIteracoes: 3,
    });
    expect(r.status).toBe("requer_humano");
    expect(r.iteracoes).toBe(3);
  });
});
