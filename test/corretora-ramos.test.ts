// Gate de produtos por corretora: fail-open quando não há config; só ramos
// ativos quando há; ramoHabilitado respeita o conjunto.
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: null as Array<{ ramo: string; ativo: boolean }> | null,
}));

vi.mock("../src/integrations/whatsapp/supabase", () => ({
  getSupabaseAdmin: () => ({
    from() {
      const ctx = {
        select: () => ctx,
        eq: () => ctx,
        then: (onF: (v: unknown) => unknown) =>
          Promise.resolve({ data: h.rows, error: null }).then(onF),
      };
      return ctx;
    },
  }),
}));

import {
  lerRamosHabilitados,
  ramoHabilitado,
  _resetRamosCache,
} from "../src/services/corretora-ramos.service";

beforeEach(() => {
  h.rows = null;
  _resetRamosCache();
});

describe("corretora-ramos (gate de produtos)", () => {
  it("sem config (0 linhas) → fail-open: TODOS os ramos", async () => {
    h.rows = [];
    const r = await lerRamosHabilitados("corr-1");
    expect(r.has("auto")).toBe(true);
    expect(r.has("vida")).toBe(true);
    expect(r.has("saude")).toBe(true);
  });

  it("com config → só os ramos ativos", async () => {
    h.rows = [
      { ramo: "auto", ativo: true },
      { ramo: "vida", ativo: false },
      { ramo: "residencial", ativo: true },
    ];
    const r = await lerRamosHabilitados("corr-2");
    expect(r.has("auto")).toBe(true);
    expect(r.has("residencial")).toBe(true);
    expect(r.has("vida")).toBe(false);
    expect(await ramoHabilitado("corr-2", "vida")).toBe(false);
    expect(await ramoHabilitado("corr-2", "auto")).toBe(true);
  });

  it("erro de leitura → fail-open (não trava a corretora)", async () => {
    // força exceção: rows não-array faz o .filter quebrar dentro do try → catch
    h.rows = undefined as never;
    const r = await lerRamosHabilitados("corr-3");
    expect(r.has("auto")).toBe(true);
  });
});
