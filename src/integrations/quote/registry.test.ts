// Registry de providers por ramo: auto é automatizado (Segfy); demais ramos caem
// no provider não-automatizado; ramo desconhecido/nulo cai no default seguro.
import { describe, it, expect } from "vitest";
import { getProvider } from "./registry";

describe("getProvider (registry de cotação)", () => {
  it("auto → provider automatizado (segfy)", () => {
    const p = getProvider("auto");
    expect(p.automatizado).toBe(true);
    expect(p.nome).toBe("segfy-auto");
  });

  for (const ramo of ["vida", "residencial", "empresarial", "saude"] as const) {
    it(`${ramo} → provider não-automatizado`, () => {
      const p = getProvider(ramo);
      expect(p.automatizado).toBe(false);
      expect(p.nome).toBe("nao-automatizado");
    });
  }

  it("ramo nulo/desconhecido → auto (retrocompat: conversa sem ramo é auto)", () => {
    // normalizarRamo colapsa null/undefined/desconhecido em 'auto', preservando o
    // comportamento mono-ramo atual para conversas antigas (ramo NULL pós-backfill).
    expect(getProvider(null).nome).toBe("segfy-auto");
    expect(getProvider("inexistente").nome).toBe("segfy-auto");
    expect(getProvider(undefined).nome).toBe("segfy-auto");
  });
});
