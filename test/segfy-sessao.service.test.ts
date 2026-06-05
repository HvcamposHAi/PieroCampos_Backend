/**
 * segfy-sessao.service: round-trip da sessão cifrada (restaurarSessao), derivação
 * de status (statusSessao) e marcação de expiração. Mocka Supabase e o scraper
 * (Playwright) — usa a cifra REAL com uma chave de teste.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const estado = vi.hoisted(() => ({
  selectRow: { data: null as unknown, error: null as unknown },
  updates: [] as Array<Record<string, unknown>>,
  upserts: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/integrations/whatsapp/supabase", () => ({
  getSupabaseAdmin: () => ({
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => estado.selectRow,
        update: (patch: Record<string, unknown>) => {
          estado.updates.push(patch);
          return { eq: async () => ({ error: null }) };
        },
        upsert: async (patch: Record<string, unknown>) => {
          estado.upserts.push(patch);
          return { error: null };
        },
      };
      return chain;
    },
  }),
  _resetSupabaseAdminCache: () => undefined,
}));

vi.mock("../src/integrations/segfy/segfy.scraper", () => ({
  iniciarReauthSegfy: vi.fn(),
  confirmarReauthSegfy: vi.fn(),
  abortarReauthSegfy: vi.fn(async () => undefined),
}));

import { cifrar, _resetCipherCache } from "../src/integrations/whatsapp/cipher";
import { _resetEnvCache } from "../src/config/env";
import { restaurarSessao, statusSessao, marcarSessaoExpirada } from "../src/services/segfy-sessao.service";

const CHAVE = "A".repeat(43) + "="; // 32 bytes base64

beforeEach(() => {
  process.env.WA_ENABLED = "false";
  process.env.BIA_ENABLED = "false";
  process.env.WA_AUTH_ENCRYPTION_KEY = CHAVE;
  _resetEnvCache();
  _resetCipherCache();
  estado.selectRow = { data: null, error: null };
  estado.updates = [];
  estado.upserts = [];
});

function linhaSessao(over: Record<string, unknown> = {}) {
  const storageState = {
    cookies: [
      { name: "trust", value: "abc", domain: ".segfy.com" },
      { name: "lixo", value: "zzz", domain: "example.com" },
    ],
  };
  return {
    sessao_cifrada: cifrar(storageState),
    tokens_cifrados: cifrar({ authAutomationToken: "atk", userAutomationToken: "utk" }),
    sessao_status: "ativa",
    sessao_atualizada_em: new Date().toISOString(),
    sessao_valida_ate: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
    reauth_por: "op@x.com",
    ...over,
  };
}

describe("restaurarSessao", () => {
  it("decifra cookie (só domínio segfy) + tokens persistidos", async () => {
    estado.selectRow = { data: linhaSessao(), error: null };
    const s = await restaurarSessao();
    expect(s?.cookie).toBe("trust=abc"); // lixo de example.com fica de fora
    expect(s?.tokens).toEqual({ bearer: "Bearer atk", automationToken: "utk" });
    expect((s?.tokensValidadeMs ?? 0)).toBeGreaterThan(0);
  });

  it("sessão ausente → null", async () => {
    estado.selectRow = { data: null, error: null };
    expect(await restaurarSessao()).toBeNull();
  });

  it("sessão expirada (status) → null", async () => {
    estado.selectRow = { data: linhaSessao({ sessao_status: "expirada" }), error: null };
    expect(await restaurarSessao()).toBeNull();
  });

  it("sessão vencida pela data → null", async () => {
    estado.selectRow = { data: linhaSessao({ sessao_valida_ate: new Date(Date.now() - 1000).toISOString() }), error: null };
    expect(await restaurarSessao()).toBeNull();
  });
});

describe("statusSessao", () => {
  it("ativa quando há sessão e validade futura", async () => {
    estado.selectRow = { data: linhaSessao(), error: null };
    const r = await statusSessao();
    expect(r.status).toBe("ativa");
    expect(r.reauth_por).toBe("op@x.com");
  });

  it("expirada quando a data já passou (mesmo com status 'ativa' no banco)", async () => {
    estado.selectRow = { data: linhaSessao({ sessao_valida_ate: new Date(Date.now() - 1000).toISOString() }), error: null };
    expect((await statusSessao()).status).toBe("expirada");
  });

  it("ausente quando não há linha/sessão", async () => {
    estado.selectRow = { data: null, error: null };
    expect((await statusSessao()).status).toBe("ausente");
  });
});

describe("marcarSessaoExpirada", () => {
  it("grava sessao_status='expirada'", async () => {
    await marcarSessaoExpirada();
    expect(estado.updates.at(-1)).toMatchObject({ sessao_status: "expirada" });
  });
});
