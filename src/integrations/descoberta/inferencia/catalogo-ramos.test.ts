import { describe, it, expect } from "vitest";
import { detectarRamos, normalizarRamoLivre } from "./catalogo-ramos";
import type { HarResumo } from "../descoberta.types";

describe("normalizarRamoLivre", () => {
  it("normaliza sinônimos para slug canônico", () => {
    expect(normalizarRamoLivre("Automóvel")).toEqual({ slug: "auto", conhecido: true });
    expect(normalizarRamoLivre("Seguro Residência")).toEqual({ slug: "residencial", conhecido: true });
    expect(normalizarRamoLivre("Fiança Locatícia")).toEqual({ slug: "fianca_locaticia", conhecido: true });
  });
  it("desconhecido vira kebab/underscore livre", () => {
    const r = normalizarRamoLivre("Seguro Pet Premium");
    expect(r.conhecido).toBe(false);
    expect(r.slug).toBe("seguro_pet_premium");
  });
});

describe("detectarRamos", () => {
  it("detecta ramos por menu do DOM e marca suporte", () => {
    const har: HarResumo = {
      entradas: [],
      domLinks: [
        { texto: "Auto", href: "/produtos/auto" },
        { texto: "Vida", href: "/produtos/vida" },
      ],
    };
    const ramos = detectarRamos({ har, ramosSuportados: ["auto"] });
    const auto = ramos.find((r) => r.ramo === "auto");
    const vida = ramos.find((r) => r.ramo === "vida");
    expect(auto?.statusSuporte).toBe("suportado");
    expect(vida?.statusSuporte).toBe("nao_mapeado");
  });

  it("detecta ramos por caminho no HAR", () => {
    const har: HarResumo = {
      entradas: [{ metodo: "GET", url: "https://x.com/ramos/residencial", status: 200, reqHeaders: {} }],
    };
    const ramos = detectarRamos({ har });
    expect(ramos.some((r) => r.ramo === "residencial")).toBe(true);
  });
});
