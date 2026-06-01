/**
 * registrarStatusEntrega: mapeia o ack do Baileys (WAMessageStatus) para
 * mensagens.status_entrega, só AVANÇA (não regride), e marca entregue_em quando
 * >=3. Mocka getSupabaseAdmin capturando o update.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  row: null as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updatePatch: null as any,
}));

vi.mock("../src/integrations/whatsapp/supabase", () => ({
  getSupabaseAdmin: () => ({
    from() {
      const ctx = {
        select: () => ctx,
        eq: () => ctx,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update: (p: any) => {
          h.updatePatch = p;
          return ctx;
        },
        async maybeSingle() {
          return { data: h.row, error: null };
        },
        // o update é aguardado direto (sem maybeSingle)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then(onF: (v: any) => unknown, onR?: (e: unknown) => unknown) {
          return Promise.resolve({ error: null }).then(onF, onR);
        },
      };
      return ctx;
    },
  }),
}));

import { registrarStatusEntrega } from "../src/integrations/whatsapp/persistence";

beforeEach(() => {
  h.row = null;
  h.updatePatch = null;
});

describe("registrarStatusEntrega", () => {
  it("avança 2→3 e marca entregue_em", async () => {
    h.row = { id: "m1", status_entrega: 2 };
    await registrarStatusEntrega("sid1", 3);
    expect(h.updatePatch?.status_entrega).toBe(3);
    expect(h.updatePatch?.entregue_em).toBeTruthy();
  });

  it("não regride (lido=4 não vira entregue=3)", async () => {
    h.row = { id: "m1", status_entrega: 4 };
    await registrarStatusEntrega("sid1", 3);
    expect(h.updatePatch).toBeNull();
  });

  it("status < 2 (pending) é ignorado sem tocar no banco", async () => {
    h.row = { id: "m1", status_entrega: null };
    await registrarStatusEntrega("sid1", 1);
    expect(h.updatePatch).toBeNull();
  });

  it("providerMsgId desconhecido (sem row) → não atualiza", async () => {
    h.row = null;
    await registrarStatusEntrega("desconhecido", 3);
    expect(h.updatePatch).toBeNull();
  });

  it("status 2 em mensagem sem status (null) → grava 2 sem entregue_em", async () => {
    h.row = { id: "m1", status_entrega: null };
    await registrarStatusEntrega("sid1", 2);
    expect(h.updatePatch?.status_entrega).toBe(2);
    expect(h.updatePatch?.entregue_em).toBeUndefined();
  });
});
