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
        // corretoraDoCanal usa maybeSingle: devolve null → sem filtro de corretora
        // (mantém o comportamento original deste teste de obterConfigEfetiva).
        maybeSingle: async () => ({ data: null, error: null }),
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
import { buildBlocoPersonalizacao, buildSystemPromptDinamico } from "../src/lib/system-prompt";
import { getRoteiroEfetivo } from "../src/lib/roteiros";
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
    emojis: "moderado",
    estilo_amostra: null,
    campos_excluidos: {},
    perguntas_customizadas: {},
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

  it("emojis: override vence; sem ninguém → 'moderado'; estilo_amostra segue preferir()", () => {
    // override define emojis e estilo; padrão tem outro estilo
    const m1 = mergeConfig(
      row({ emojis: "sem", estilo_amostra: "padrão" }),
      row({ canal_id: "c1", emojis: "a_vontade", estilo_amostra: "override" }),
    );
    expect(m1.emojis).toBe("a_vontade");
    expect(m1.estiloAmostra).toBe("override");
    // override com estilo nulo → herda o estilo do padrão (preferir); emojis do override vence
    const m2 = mergeConfig(
      row({ emojis: "a_vontade", estilo_amostra: "padrão" }),
      row({ canal_id: "c1", emojis: "moderado", estilo_amostra: null }),
    );
    expect(m2.estiloAmostra).toBe("padrão");
    expect(m2.emojis).toBe("moderado");
    // sem override (null) → tudo cai no padrão
    const m3 = mergeConfig(row({ emojis: "sem", estilo_amostra: "só padrão" }), null);
    expect(m3.emojis).toBe("sem");
    expect(m3.estiloAmostra).toBe("só padrão");
  });

  it("campos da cotação: override substitui os mapas inteiros", () => {
    const padrao = row({ campos_excluidos: { renovacao: ["bonus"] } });
    const override = row({
      canal_id: "c1",
      campos_excluidos: { seguro_novo: ["telefone_contato"] },
      perguntas_customizadas: {
        seguro_novo: [{ id: "x", chave: "custom_x", pergunta: "Tem filhos?" }],
      },
    });
    const m = mergeConfig(padrao, override);
    expect(m.camposExcluidos).toEqual({ seguro_novo: ["telefone_contato"] });
    expect(m.perguntasCustomizadas.seguro_novo?.[0]?.chave).toBe("custom_x");
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

  it("emojis: cada nível emite a instrução correta; 'moderado' = comportamento atual", () => {
    const bSem = buildBlocoPersonalizacao(mergeConfig(row({ emojis: "sem" }), null));
    const bMod = buildBlocoPersonalizacao(mergeConfig(row({ emojis: "moderado" }), null));
    const bAvt = buildBlocoPersonalizacao(mergeConfig(row({ emojis: "a_vontade" }), null));
    expect(bSem).toContain("Não use emojis");
    expect(bMod).toContain("no máximo 1 emoji por mensagem");
    expect(bAvt).toContain("à vontade");
  });

  it("clone: com estilo_amostra injeta a seção E reafirma as REGRAS ABSOLUTAS; sem ele, nada", () => {
    const com = buildBlocoPersonalizacao(
      mergeConfig(row({ estilo_amostra: "Opa, bora resolver!\nFechou então 👊" }), null),
    );
    expect(com).toContain("CLONAGEM DE ESTILO");
    expect(com).toContain("Opa, bora resolver!");
    expect(com).toContain("REGRAS ABSOLUTAS");
    expect(com).toContain("fora de seguros");

    const sem = buildBlocoPersonalizacao(mergeConfig(row({ estilo_amostra: null }), null));
    expect(sem).not.toContain("CLONAGEM DE ESTILO");
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

  it("chavesExtras: aceita chave custom_ no atualizar_dados; descarta fora dela", async () => {
    mockCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "atualizar_dados",
            input: { campos: { custom_filhos: "2", custom_intruso: "x" } },
          },
        ],
      })
      .mockResolvedValueOnce(respFinal);
    const r = await chamarBia({
      systemBase: "b",
      systemDinamico: "d",
      historico: [{ role: "user", content: "tenho 2 filhos" }],
      chavesExtras: ["custom_filhos"],
    });
    expect(r.camposExtraidos.custom_filhos).toBe("2");
    expect(r.camposExtraidos.custom_intruso).toBeUndefined(); // fora da whitelist
  });
});

describe("getRoteiroEfetivo", () => {
  it("remove opcional excluído, mantém TODOS os obrigatórios e anexa custom", () => {
    const base = getRoteiroEfetivo("seguro_novo")!;
    const obrigatorios = base.campos.filter((c) => c.obrigatorio).map((c) => c.chave);

    const efetivo = getRoteiroEfetivo(
      "seguro_novo",
      ["bonus"],
      [{ id: "x", chave: "custom_x", pergunta: "Tem filhos?" }],
    )!;
    const chaves = efetivo.campos.map((c) => c.chave);

    // obrigatórios preservados
    for (const ch of obrigatorios) expect(chaves).toContain(ch);
    // opcional excluído sumiu
    expect(chaves).not.toContain("bonus");
    // custom anexado como opcional
    const custom = efetivo.campos.find((c) => c.chave === "custom_x");
    expect(custom?.obrigatorio).toBe(false);
    expect(custom?.rotulo).toBe("Tem filhos?");
  });

  it("não deixa excluir campo obrigatório", () => {
    const efetivo = getRoteiroEfetivo("seguro_novo", ["cpf"])!;
    expect(efetivo.campos.some((c) => c.chave === "cpf")).toBe(true);
  });

  it("categoria sem roteiro → null", () => {
    expect(getRoteiroEfetivo("duvida")).toBeNull();
  });
});

describe("buildSystemPromptDinamico: campos da cotação", () => {
  const baseInput = {
    contextoRAG: "",
    dadosColetados: {},
    pendentesObrigatorios: [],
    proximoCampo: null,
    modo: "ativo" as const,
  };

  it("omite o opcional excluído e inclui a pergunta custom", () => {
    const prompt = buildSystemPromptDinamico({
      ...baseInput,
      categoria: "seguro_novo",
      camposExcluidos: ["bonus"],
      camposCustom: [{ id: "x", chave: "custom_x", pergunta: "Tem filhos?" }],
    });
    expect(prompt).not.toContain("bonus (");
    expect(prompt).toContain("custom_x");
    expect(prompt).toContain("Tem filhos?");
    // obrigatório segue listado
    expect(prompt).toContain("cpf");
  });
});
