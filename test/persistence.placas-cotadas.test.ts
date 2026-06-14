/**
 * listarPlacasCotadas: lê as placas já cotadas (snapshot dados_entrada.placa) de
 * todas as cotações da conversa, normalizadas e deduplicadas. Best-effort.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const estado = vi.hoisted(() => ({
  rows: [] as Array<{ dados_entrada?: unknown }>,
  error: null as null | { message: string },
}));

vi.mock("../src/integrations/whatsapp/supabase", () => {
  const builder = () => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    // eq("conversa_id", id) é o último elo e é AGUARDADO direto (thenable).
    q.eq = () => ({
      then: (resolve: (v: unknown) => void) => resolve({ data: estado.rows, error: estado.error }),
    });
    return q;
  };
  return { getSupabaseAdmin: () => ({ from: () => builder() }) };
});

import { listarPlacasCotadas, normalizarPlaca } from "../src/integrations/whatsapp/persistence";

beforeEach(() => {
  estado.rows = [];
  estado.error = null;
});

describe("normalizarPlaca", () => {
  it("tira máscara e sobe caixa; rejeita lixo curto", () => {
    expect(normalizarPlaca("abc-1d23")).toBe("ABC1D23");
    expect(normalizarPlaca("ABC 1234")).toBe("ABC1234");
    expect(normalizarPlaca("xx")).toBeNull();
    expect(normalizarPlaca(123 as unknown)).toBeNull();
  });
});

describe("listarPlacasCotadas", () => {
  it("coleta e deduplica as placas dos snapshots", async () => {
    estado.rows = [
      { dados_entrada: { placa: "abc1d23", cpf: "1" } },
      { dados_entrada: { placa: "ABC1D23" } }, // mesma placa (dup)
      { dados_entrada: { placa: "xyz9k88" } },
      { dados_entrada: { cpf: "sem placa" } },
    ];
    const placas = await listarPlacasCotadas("conv-1");
    expect(placas.has("ABC1D23")).toBe(true);
    expect(placas.has("XYZ9K88")).toBe(true);
    expect(placas.size).toBe(2);
  });

  it("erro na query → Set vazio (best-effort, não lança)", async () => {
    estado.error = { message: "boom" };
    const placas = await listarPlacasCotadas("conv-1");
    expect(placas.size).toBe(0);
  });
});
