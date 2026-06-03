/**
 * Save ESSENCIAL por linha (app móvel do operador): salvarConfigEssencialLinha
 * deve trocar SÓ os 5 campos essenciais e PRESERVAR os avançados que o admin
 * configurou (exemplos, variar_texto, campos_excluidos, perguntas_customizadas).
 * Base = override existente da linha; sem override, herda do PADRÃO.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  override: null as Record<string, unknown> | null, // row de canal_id = canalId
  padrao: null as Record<string, unknown> | null, // row de canal_id IS NULL
  overrideId: null as string | null, // id p/ acharIdLinha(canalId)
  saved: [] as Array<{ op: "update" | "insert"; payload: Record<string, unknown> }>,
}));

vi.mock("../src/integrations/whatsapp/supabase", () => ({
  getSupabaseAdmin: () => ({
    from() {
      let cols = "*";
      let alvo: "canal" | "padrao" | null = null;
      let op: "select" | "update" | "insert" = "select";
      let payload: Record<string, unknown> | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx: any = {
        select: (c: string) => {
          cols = c;
          return ctx;
        },
        eq: (col: string) => {
          if (col === "canal_id") alvo = "canal";
          return ctx;
        },
        is: (col: string) => {
          if (col === "canal_id") alvo = "padrao";
          return ctx;
        },
        update: (p: Record<string, unknown>) => {
          op = "update";
          payload = p;
          return ctx;
        },
        insert: (p: Record<string, unknown>) => {
          op = "insert";
          payload = p;
          return ctx;
        },
        async maybeSingle() {
          if (cols.trim() === "id") {
            return { data: alvo === "canal" && h.overrideId ? { id: h.overrideId } : null, error: null };
          }
          return { data: alvo === "canal" ? h.override : h.padrao, error: null };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then(onF: (v: any) => unknown, onR?: (e: unknown) => unknown) {
          if ((op === "update" || op === "insert") && payload) {
            h.saved.push({ op, payload });
          }
          return Promise.resolve({ error: null }).then(onF, onR);
        },
      };
      return ctx;
    },
  }),
}));

import { salvarConfigEssencialLinha } from "../src/services/agente-config.service";

function rowBase(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    canal_id: null,
    ativo: true,
    tom_voz: "proximo_caloroso",
    persona: "persona admin",
    saudacao: "ola",
    exemplos: "exemplo do admin",
    variar_texto: false,
    criatividade: "consistente",
    objetivo: "cotacao",
    campos_excluidos: {},
    perguntas_customizadas: {},
    atualizado_em: null,
    atualizado_por: null,
    ...over,
  };
}

beforeEach(() => {
  h.override = null;
  h.padrao = null;
  h.overrideId = null;
  h.saved.length = 0;
});

const PATCH = {
  objetivo: "venda" as const,
  tom_voz: "direto_objetivo" as const,
  criatividade: "criativo" as const,
  persona: "nova persona",
  saudacao: "novo oi",
};

describe("salvarConfigEssencialLinha", () => {
  it("preserva avançados do override e troca só os essenciais", async () => {
    h.override = rowBase({
      canal_id: "c1",
      exemplos: "exemplo do admin",
      variar_texto: true,
      emojis: "a_vontade",
      estilo_amostra: "amostra do admin",
    });
    h.overrideId = "row-1";

    await salvarConfigEssencialLinha({ canalId: "c1", patch: PATCH, porEmail: "op@x.com" });

    expect(h.saved).toHaveLength(1);
    const p = h.saved[0]!.payload;
    expect(h.saved[0]!.op).toBe("update");
    // essenciais aplicados
    expect(p.objetivo).toBe("venda");
    expect(p.tom_voz).toBe("direto_objetivo");
    expect(p.criatividade).toBe("criativo");
    expect(p.persona).toBe("nova persona");
    expect(p.saudacao).toBe("novo oi");
    // avançados PRESERVADOS do override (inclui emojis e a amostra de clone)
    expect(p.exemplos).toBe("exemplo do admin");
    expect(p.variar_texto).toBe(true);
    expect(p.emojis).toBe("a_vontade");
    expect(p.estilo_amostra).toBe("amostra do admin");
    expect(p.canal_id).toBe("c1");
  });

  it("sem override, herda os avançados do PADRÃO e cria override da linha (insert)", async () => {
    h.override = null;
    h.overrideId = null; // acharIdLinha não acha → insert
    h.padrao = rowBase({ exemplos: "exemplo padrao", variar_texto: false });

    await salvarConfigEssencialLinha({ canalId: "c2", patch: PATCH, porEmail: "op@x.com" });

    expect(h.saved).toHaveLength(1);
    const p = h.saved[0]!.payload;
    expect(h.saved[0]!.op).toBe("insert");
    expect(p.canal_id).toBe("c2");
    expect(p.objetivo).toBe("venda");
    // herdou avançados do padrão
    expect(p.exemplos).toBe("exemplo padrao");
    expect(p.variar_texto).toBe(false);
  });
});
