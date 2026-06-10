// Registry de providers por ramo: auto é automatizado (Segfy); demais ramos caem
// no provider não-automatizado; ramo desconhecido/nulo cai no default seguro.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock do leitor de sistema da corretora (DB) — resolveProvider só decide o
// provider AUTOMATIZADO por sistema; não queremos tocar o Supabase no teste.
const lerSistemaMock = vi.fn(async (): Promise<string> => "segfy");
vi.mock("../../services/segfy-credenciais.service", () => ({
  lerSistemaCotacao: () => lerSistemaMock(),
}));

import { getProvider, resolveProvider } from "./registry";

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

describe("resolveProvider (eixo duplo: ramo × sistema da corretora)", () => {
  beforeEach(() => lerSistemaMock.mockReset());

  it("auto + sistema 'segfy' → segfy-auto", async () => {
    lerSistemaMock.mockResolvedValue("segfy");
    const p = await resolveProvider("corr-1", "auto");
    expect(p.nome).toBe("segfy-auto");
  });

  it("auto + sistema 'aggilizador' → aggilizador-auto", async () => {
    lerSistemaMock.mockResolvedValue("aggilizador");
    const p = await resolveProvider("corr-1", "auto");
    expect(p.nome).toBe("aggilizador-auto");
    expect(p.automatizado).toBe(true);
  });

  it("auto + sistema desconhecido → default seguro (segfy-auto)", async () => {
    lerSistemaMock.mockResolvedValue("sistema_que_nao_existe");
    const p = await resolveProvider("corr-1", "auto");
    expect(p.nome).toBe("segfy-auto");
  });

  for (const ramo of ["vida", "residencial", "empresarial", "saude"] as const) {
    it(`ramo não-auto (${ramo}) → nao-automatizado INDEPENDENTE do sistema`, async () => {
      // Mesmo com sistema='aggilizador', ramo não-auto ignora o sistema. E não deve
      // nem consultar o DB (curto-circuito antes do await).
      lerSistemaMock.mockResolvedValue("aggilizador");
      const p = await resolveProvider("corr-1", ramo);
      expect(p.nome).toBe("nao-automatizado");
      expect(lerSistemaMock).not.toHaveBeenCalled();
    });
  }

  it("auto SEM corretoraId → resolve pelo default do leitor (sistema seed)", async () => {
    lerSistemaMock.mockResolvedValue("segfy");
    const p = await resolveProvider(undefined, "auto");
    expect(p.nome).toBe("segfy-auto");
  });
});
