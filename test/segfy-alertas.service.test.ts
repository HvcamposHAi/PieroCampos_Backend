/**
 * segfy-alertas.service: o aviso in-app (sino) insere 1 notificação por admin
 * ativo (tipo 'segfy_reauth', sem conversa); é best-effort (nunca lança); o
 * WhatsApp só dispara com SEGFY_ALERTA_WPP_E164 setado. Mocka Supabase.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const estado = vi.hoisted(() => ({
  operadores: [] as Array<{ id: string }>,
  inserts: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/integrations/whatsapp/supabase", () => ({
  getSupabaseAdmin: () => ({
    from: (tabela: string) => {
      if (tabela === "operadores") {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          then: (res: (v: unknown) => unknown) =>
            Promise.resolve({ data: estado.operadores, error: null }).then(res),
        };
        return chain;
      }
      if (tabela === "notificacoes") {
        return {
          insert: async (linhas: Array<Record<string, unknown>>) => {
            estado.inserts.push(...linhas);
            return { error: null };
          },
        };
      }
      // canais (WhatsApp) — não usado quando o número não está setado.
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: null }),
      };
      return chain;
    },
  }),
}));

import { notificarReauthNecessaria } from "../src/services/segfy-alertas.service";
import { _resetEnvCache } from "../src/config/env";

beforeEach(() => {
  process.env.WA_ENABLED = "false";
  process.env.BIA_ENABLED = "false";
  process.env.SEGFY_ALERTA_WPP_E164 = ""; // sem WhatsApp neste teste
  _resetEnvCache();
  estado.operadores = [];
  estado.inserts = [];
});

describe("notificarReauthNecessaria", () => {
  it("insere 1 notificação 'segfy_reauth' por admin ativo (sem conversa)", async () => {
    estado.operadores = [{ id: "adm1" }, { id: "adm2" }];
    await notificarReauthNecessaria("Sessão expirou.");
    expect(estado.inserts).toHaveLength(2);
    for (const linha of estado.inserts) {
      expect(linha.tipo).toBe("segfy_reauth");
      expect(linha.conversa_id).toBeNull();
      expect(linha.corpo).toBe("Sessão expirou.");
    }
    expect(estado.inserts.map((l) => l.operador_id)).toEqual(["adm1", "adm2"]);
  });

  it("não lança e não insere quando não há operador (best-effort)", async () => {
    estado.operadores = [];
    await expect(notificarReauthNecessaria("x")).resolves.toBeUndefined();
    expect(estado.inserts).toHaveLength(0);
  });
});
