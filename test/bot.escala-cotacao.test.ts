/**
 * `confirmarEdispararCotacao`: quando a cotação FALHA (Segfy retorna null), a
 * conversa é ESCALADA para um humano (executarHandoff) — para a Bia seguir
 * respondendo (holding) e o operador ser notificado. Idempotente: não re-escala
 * se já estava com humano.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  store: { estado: "aguardando_confirmacao_cotacao" } as { estado: string },
  dispararCotacaoSegfy: vi.fn(),
  executarHandoff: vi.fn(),
}));

vi.mock("../src/integrations/whatsapp/supabase", () => ({
  getSupabaseAdmin: () => ({
    from() {
      let op: "select" | "update" = "select";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let payload: any = null;
      const ctx = {
        select: () => ctx,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update: (p: any) => {
          op = "update";
          payload = p;
          return ctx;
        },
        eq: () => ctx,
        async maybeSingle() {
          return { data: { estado: h.store.estado }, error: null };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then(onF: (v: any) => unknown, onR?: (e: unknown) => unknown) {
          if (op === "update" && payload?.estado) h.store.estado = payload.estado;
          return Promise.resolve({ error: null }).then(onF, onR);
        },
      };
      return ctx;
    },
  }),
}));
vi.mock("../src/services/segfy-cotacao.service", () => ({
  dispararCotacaoSegfy: h.dispararCotacaoSegfy,
}));
vi.mock("../src/services/handoff.service", () => ({
  executarHandoff: h.executarHandoff,
  detectarGatilhoHandoff: () => ({ detectado: false }),
  MENSAGEM_HANDOFF: "handoff",
}));

import { confirmarEdispararCotacao } from "../src/services/bot.service";

beforeEach(() => {
  h.dispararCotacaoSegfy.mockReset();
  h.executarHandoff.mockReset().mockResolvedValue(undefined);
});

const params = () => ({
  conversaId: "conv1",
  clienteId: "cli1",
  dados: {},
  enviar: async () => {},
});

describe("confirmarEdispararCotacao — escala em falha", () => {
  it("cotação falha (null) → escala para humano (executarHandoff)", async () => {
    h.store.estado = "aguardando_confirmacao_cotacao";
    h.dispararCotacaoSegfy.mockResolvedValue(null);

    const r = await confirmarEdispararCotacao(params());
    expect(r).toEqual({ cotou: false });
    expect(h.executarHandoff).toHaveBeenCalledTimes(1);
    expect(h.executarHandoff.mock.calls[0]![0]).toMatchObject({
      conversaId: "conv1",
      motivo: "cotacao_falhou",
    });
  });

  it("idempotente: já estava em humano_assumiu → NÃO re-escala", async () => {
    h.store.estado = "humano_assumiu";
    h.dispararCotacaoSegfy.mockResolvedValue(null);

    const r = await confirmarEdispararCotacao(params());
    expect(r).toEqual({ cotou: false });
    expect(h.executarHandoff).not.toHaveBeenCalled();
  });

  it("cotação OK → não escala e envia comparativo", async () => {
    h.store.estado = "aguardando_confirmacao_cotacao";
    h.dispararCotacaoSegfy.mockResolvedValue({ texto: "comparativo aqui" });

    const textos: string[] = [];
    const r = await confirmarEdispararCotacao({ ...params(), enviar: async (t) => { textos.push(t); } });
    expect(r).toEqual({ cotou: true });
    expect(h.executarHandoff).not.toHaveBeenCalled();
    expect(textos).toContain("comparativo aqui");
    expect(h.store.estado).toBe("cotacao_enviada");
  });
});
