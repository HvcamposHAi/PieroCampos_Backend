/**
 * segfy-sessao.service: round-trip da sessão cifrada (restaurarSessao), derivação
 * de status (statusSessao) e marcação de expiração. Mocka Supabase e o scraper
 * (Playwright) — usa a cifra REAL com uma chave de teste.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const estado = vi.hoisted(() => ({
  selectRow: { data: null as unknown, error: null as unknown },
  updates: [] as Array<Record<string, unknown>>,
  updateReturn: [{ id: "singleton" }] as Array<{ id: string }>, // linha existe por padrão
}));

vi.mock("../src/integrations/whatsapp/supabase", () => ({
  getSupabaseAdmin: () => ({
    from: () => {
      // Resultado de update().eq(): thenable (p/ `await update().eq()`) E com .select()
      // (p/ `update().eq().select()` que persistirSessao/importarSessao usam).
      const eqResult = {
        select: async () => ({ data: estado.updateReturn, error: null }),
        then: (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res),
      };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => estado.selectRow,
        update: (patch: Record<string, unknown>) => {
          estado.updates.push(patch);
          return { eq: () => eqResult };
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

import { cifrar, decifrar, _resetCipherCache } from "../src/integrations/whatsapp/cipher";
import { _resetEnvCache } from "../src/config/env";
import {
  restaurarSessao,
  statusSessao,
  marcarSessaoExpirada,
  importarSessao,
  avisoProativoSessao,
  gravarTokensHarvest,
} from "../src/services/segfy-sessao.service";

const CHAVE = "A".repeat(43) + "="; // 32 bytes base64

beforeEach(() => {
  process.env.WA_ENABLED = "false";
  process.env.BIA_ENABLED = "false";
  process.env.WA_AUTH_ENCRYPTION_KEY = CHAVE;
  _resetEnvCache();
  _resetCipherCache();
  estado.selectRow = { data: null, error: null };
  estado.updates = [];
  estado.updateReturn = [{ id: "singleton" }];
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
    sessao_ultimo_aviso_em: null,
    ...over,
  };
}

const umDia = 24 * 3600_000;

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

  it("só-tokens (sem cookie/sessao_cifrada) → devolve tokens (agente de colheita)", async () => {
    estado.selectRow = {
      data: linhaSessao({ sessao_cifrada: null, tokens_cifrados: cifrar({ authAutomationToken: "atk", userAutomationToken: "utk" }), sessao_atualizada_em: new Date().toISOString() }),
      error: null,
    };
    const s = await restaurarSessao();
    expect(s?.cookie).toBeUndefined();
    expect(s?.tokens).toEqual({ bearer: "Bearer atk", automationToken: "utk" });
    expect((s?.tokensValidadeMs ?? 0)).toBeGreaterThan(0);
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

describe("restaurarSessao — cookie importado", () => {
  it("lê o cookieHeader importado (sem storageState/cookies[])", async () => {
    estado.selectRow = {
      data: linhaSessao({ sessao_cifrada: cifrar({ cookieHeader: "trust=abc; sess=xyz" }), tokens_cifrados: null }),
      error: null,
    };
    const s = await restaurarSessao();
    expect(s?.cookie).toBe("trust=abc; sess=xyz");
    expect(s?.tokens).toBeUndefined();
  });
});

describe("importarSessao", () => {
  it("grava o cookie CIFRADO + status ativa e validade ~30d (via UPDATE, sem tocar email)", async () => {
    await importarSessao({ cookieHeader: "trust=abc; sess=xyz", porEmail: "op@x.com" });
    const up = estado.updates.at(-1)!;
    expect(up).not.toHaveProperty("email"); // não toca a coluna NOT NULL
    expect(up.sessao_status).toBe("ativa");
    expect(up.reauth_por).toBe("op@x.com");
    expect(up.sessao_valida_ate).toBeTruthy();
    // cifrado e recuperável (round-trip), nunca em claro:
    expect(decifrar<{ cookieHeader: string }>(up.sessao_cifrada as never).cookieHeader).toBe(
      "trust=abc; sess=xyz",
    );
    expect(JSON.stringify(up.sessao_cifrada)).not.toContain("trust=abc");
  });

  it("guarda tokens de automação quando fornecidos", async () => {
    await importarSessao({
      cookieHeader: "trust=abc",
      tokens: { authAutomationToken: "atk", userAutomationToken: "utk" },
    });
    const up = estado.updates.at(-1)!;
    expect(up.tokens_cifrados).toBeTruthy();
    expect(decifrar<{ userAutomationToken: string }>(up.tokens_cifrados as never).userAutomationToken).toBe("utk");
  });

  it("falha clara quando a linha de credenciais não existe", async () => {
    estado.updateReturn = []; // nenhuma linha singleton
    await expect(importarSessao({ cookieHeader: "trust=abc" })).rejects.toThrow(/não configuradas/);
  });
});

describe("gravarTokensHarvest", () => {
  it("grava tokens cifrados + atualiza timestamp/status e retorna true", async () => {
    const ok = await gravarTokensHarvest({ authAutomationToken: "atk", userAutomationToken: "utk" });
    expect(ok).toBe(true);
    const up = estado.updates.at(-1)!;
    expect(up.sessao_status).toBe("ativa");
    expect(up.sessao_atualizada_em).toBeTruthy();
    expect(decifrar<{ userAutomationToken: string }>(up.tokens_cifrados as never).userAutomationToken).toBe("utk");
  });

  it("retorna false quando não há linha de credenciais", async () => {
    estado.updateReturn = [];
    expect(await gravarTokensHarvest({ authAutomationToken: "a", userAutomationToken: "u" })).toBe(false);
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
  it("grava sessao_status='expirada' e retorna TRUE na transição (estava ativa)", async () => {
    estado.selectRow = { data: linhaSessao({ sessao_status: "ativa" }), error: null };
    const transicionou = await marcarSessaoExpirada();
    expect(transicionou).toBe(true);
    expect(estado.updates.at(-1)).toMatchObject({ sessao_status: "expirada" });
  });

  it("retorna FALSE quando já estava expirada (evita aviso repetido)", async () => {
    estado.selectRow = { data: linhaSessao({ sessao_status: "expirada" }), error: null };
    expect(await marcarSessaoExpirada()).toBe(false);
  });
});

describe("avisoProativoSessao", () => {
  it("avisa quando faltam ≤ N dias e grava o throttle", async () => {
    estado.selectRow = { data: linhaSessao({ sessao_valida_ate: new Date(Date.now() + 2 * umDia).toISOString() }), error: null };
    const r = await avisoProativoSessao();
    expect(r.avisar).toBe(true);
    expect(estado.updates.at(-1)).toHaveProperty("sessao_ultimo_aviso_em");
  });

  it("NÃO avisa quando ainda falta muito (> N dias)", async () => {
    estado.selectRow = { data: linhaSessao({ sessao_valida_ate: new Date(Date.now() + 20 * umDia).toISOString() }), error: null };
    expect((await avisoProativoSessao()).avisar).toBe(false);
  });

  it("NÃO avisa dentro da janela de throttle (aviso recente)", async () => {
    estado.selectRow = {
      data: linhaSessao({
        sessao_valida_ate: new Date(Date.now() + 2 * umDia).toISOString(),
        sessao_ultimo_aviso_em: new Date(Date.now() - 3600_000).toISOString(), // 1h atrás
      }),
      error: null,
    };
    expect((await avisoProativoSessao()).avisar).toBe(false);
  });
});
