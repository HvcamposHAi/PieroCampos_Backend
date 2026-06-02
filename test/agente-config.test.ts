/**
 * Comportamento configurável da Bia por linha. Cobre:
 *  - mergeConfig (padrão+override) e o mapa criatividade→temperature (puros);
 *  - buildBlocoPersonalizacao (bloco 2 do system prompt, com o guard de compliance);
 *  - obterConfigEfetiva com o supabase fakeado;
 *  - chamarBia: SEM personalização → 2 blocos e sem temperature (zero impacto);
 *    COM personalização → 3 blocos (2º cacheado) e temperature enviada.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const store = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock("../src/integrations/whatsapp/supabase", () => ({
  getSupabaseAdmin: () => ({
    from() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx: any = {
        select: () => ctx,
        or: () => ctx,
        is: () => ctx,
        eq: () => ctx,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then: (onF: (v: any) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve({ data: store.rows, error: null }).then(onF, onR),
      };
      return ctx;
    },
  }),
}));

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_opts: any) {}
  },
}));

import {
  CRIATIVIDADE_TEMPERATURA,
  mergeConfig,
  obterConfigEfetiva,
  type AgenteConfigRow,
} from "../src/services/agente-config.service";
import { buildBlocoPersonalizacao } from "../src/lib/system-prompt";
import { chamarBia, _resetClaudeClient } from "../src/integrations/claude/claude.client";
import { _resetEnvCache } from "../src/config/env";

function row(over: Partial<AgenteConfigRow> = {}): AgenteConfigRow {
  return {
    canal_id: null,
    ativo: true,
    tom_voz: "proximo_caloroso",
    persona: null,
    saudacao: null,
    exemplos: null,
    variar_texto: true,
    criatividade: "equilibrado",
    objetivo: "cotacao",
    atualizado_em: null,
    atualizado_por: null,
    ...over,
  };
}

beforeEach(() => {
  store.rows = [];
  process.env.BIA_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.WA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "false";
  _resetEnvCache();
  _resetClaudeClient();
  mockCreate.mockReset();
});

describe("mergeConfig + criatividade→temperature", () => {
  it("override vence; texto nulo cai no padrão", () => {
    const padrao = row({ persona: "padrão persona", criatividade: "equilibrado", objetivo: "cotacao" });
    const override = row({
      canal_id: "c1",
      tom_voz: "entusiasta",
      persona: null,
      criatividade: "criativo",
      objetivo: "venda",
    });
    const m = mergeConfig(padrao, override);
    expect(m.tomVoz).toBe("entusiasta");
    expect(m.persona).toBe("padrão persona"); // override null → herda padrão
    expect(m.criatividade).toBe("criativo");
    expect(m.objetivo).toBe("venda");
    expect(m.temperature).toBe(CRIATIVIDADE_TEMPERATURA.criativo);
  });

  it("mapa de temperatura é o esperado", () => {
    expect(CRIATIVIDADE_TEMPERATURA).toEqual({ consistente: 0.3, equilibrado: 0.6, criativo: 0.9 });
  });
});

describe("buildBlocoPersonalizacao", () => {
  it("inclui o guard de compliance, o tom e os campos preenchidos", () => {
    const bloco = buildBlocoPersonalizacao(
      mergeConfig(
        row({
          tom_voz: "entusiasta",
          persona: "seja animada",
          saudacao: "Oi! Sou a Bia",
          exemplos: "Perfeito!\nJá anotei",
          variar_texto: true,
          criatividade: "criativo",
          objetivo: "venda",
        }),
        null,
      ),
    );
    expect(bloco).toContain("NUNCA sobrepõe as REGRAS ABSOLUTAS");
    expect(bloco).toContain("entusiasta");
    expect(bloco).toContain("Objetivo nesta linha");
    expect(bloco).toContain("seja animada");
    expect(bloco).toContain("Oi! Sou a Bia");
    expect(bloco).toContain("Já anotei");
    expect(bloco.toLowerCase()).toContain("varie");
  });
});

describe("obterConfigEfetiva", () => {
  it("sem nenhuma linha → null (preserva comportamento atual)", async () => {
    store.rows = [];
    expect(await obterConfigEfetiva("c1")).toBeNull();
  });

  it("só padrão → usa o padrão", async () => {
    store.rows = [row({ canal_id: null, tom_voz: "formal_profissional", criatividade: "consistente" })];
    const cfg = await obterConfigEfetiva("c1");
    expect(cfg?.tomVoz).toBe("formal_profissional");
    expect(cfg?.temperature).toBe(0.3);
  });

  it("override ativo vence o padrão", async () => {
    store.rows = [
      row({ canal_id: null, tom_voz: "proximo_caloroso", criatividade: "equilibrado" }),
      row({ canal_id: "c1", tom_voz: "direto_objetivo", criatividade: "criativo" }),
    ];
    const cfg = await obterConfigEfetiva("c1");
    expect(cfg?.tomVoz).toBe("direto_objetivo");
    expect(cfg?.temperature).toBe(0.9);
  });

  it("override inativo é ignorado → cai no padrão", async () => {
    store.rows = [
      row({ canal_id: null, tom_voz: "proximo_caloroso" }),
      row({ canal_id: "c1", tom_voz: "entusiasta", ativo: false }),
    ];
    const cfg = await obterConfigEfetiva("c1");
    expect(cfg?.tomVoz).toBe("proximo_caloroso");
  });
});

describe("chamarBia: personalização e temperature", () => {
  const respFinal = {
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: "text", text: "oi" }],
  };

  it("SEM personalização → 2 blocos de system e nenhuma temperature", async () => {
    mockCreate.mockResolvedValueOnce(respFinal);
    await chamarBia({
      systemBase: "base",
      systemDinamico: "dinamico",
      historico: [{ role: "user", content: "oi" }],
    });
    const arg = mockCreate.mock.calls[0]![0];
    expect(arg.system).toHaveLength(2);
    expect(arg.temperature).toBeUndefined();
  });

  it("COM personalização → 3 blocos (2º cacheado) e temperature enviada", async () => {
    mockCreate.mockResolvedValueOnce(respFinal);
    await chamarBia({
      systemBase: "base",
      systemDinamico: "dinamico",
      historico: [{ role: "user", content: "oi" }],
      systemPersonalizacao: "BLOCO-PERSONA",
      temperature: 0.9,
    });
    const arg = mockCreate.mock.calls[0]![0];
    expect(arg.system).toHaveLength(3);
    expect(arg.system[1].text).toBe("BLOCO-PERSONA");
    expect(arg.system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(arg.temperature).toBe(0.9);
  });
});
