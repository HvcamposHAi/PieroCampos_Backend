/**
 * agente-config por SISTEMA: resolução tolerante (legado array vs aninhado),
 * saneamento preservando fatias de outros sistemas, e obterConfigEfetiva
 * expondo o sistema + achatando a fatia certa.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock do Supabase admin: devolve as linhas semeadas em `estado`.
const estado = vi.hoisted(() => ({
  linhas: [] as Record<string, unknown>[],
  corretoraDoCanal: "corr-1" as string | null,
  sistema: "aggilizador",
}));

vi.mock("../src/integrations/whatsapp/supabase", () => {
  const builder = (tabela: string) => {
    const q: Record<string, unknown> = {};
    const ret = () => q;
    q.select = ret;
    q.eq = (col: string, val: unknown) => {
      if (tabela === "canais" && col === "id") {
        (q as { _single?: unknown })._single = { corretora_id: estado.corretoraDoCanal };
      }
      return q;
    };
    q.is = ret;
    q.or = ret;
    q.maybeSingle = async () => ({ data: (q as { _single?: unknown })._single ?? null, error: null });
    // thenable: resolve a query "lista" (canal_agente_config)
    (q as { then?: unknown }).then = (resolve: (v: unknown) => void) =>
      resolve({ data: tabela === "canal_agente_config" ? estado.linhas : [], error: null });
    return q;
  };
  return { getSupabaseAdmin: () => ({ from: (t: string) => builder(t) }) };
});

vi.mock("../src/services/segfy-credenciais.service", () => ({
  lerSistemaCotacao: vi.fn(async () => estado.sistema),
}));

import { obterConfigEfetiva } from "../src/services/agente-config.service";

function linhaPadrao(over: Record<string, unknown>): Record<string, unknown> {
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
  estado.linhas = [];
  estado.corretoraDoCanal = "corr-1";
  estado.sistema = "aggilizador";
});

describe("obterConfigEfetiva por sistema", () => {
  it("expõe o sistema da corretora", async () => {
    estado.linhas = [linhaPadrao({})];
    const cfg = await obterConfigEfetiva("canal-1");
    expect(cfg?.sistema).toBe("aggilizador");
  });

  it("aninhado: resolve a fatia do sistema da corretora", async () => {
    estado.linhas = [
      linhaPadrao({
        campos_excluidos: {
          seguro_novo: { segfy: ["bonus"], aggilizador: ["renovacao_outro_corretor"] },
        },
      }),
    ];
    const cfg = await obterConfigEfetiva("canal-1");
    // sistema=aggilizador → pega a fatia do aggilizador
    expect(cfg?.camposExcluidos?.seguro_novo).toEqual(["renovacao_outro_corretor"]);
  });

  it("legado (array) vale p/ qualquer sistema", async () => {
    estado.linhas = [linhaPadrao({ campos_excluidos: { seguro_novo: ["bonus"] } })];
    const cfg = await obterConfigEfetiva("canal-1");
    expect(cfg?.camposExcluidos?.seguro_novo).toEqual(["bonus"]);
  });

  it("fatia de outro sistema NÃO vaza para o sistema atual", async () => {
    estado.sistema = "segfy";
    estado.linhas = [
      linhaPadrao({ campos_excluidos: { seguro_novo: { aggilizador: ["renovacao_outro_corretor"] } } }),
    ];
    const cfg = await obterConfigEfetiva("canal-1");
    // sistema=segfy, mas só há fatia aggilizador → nada excluído p/ segfy
    expect(cfg?.camposExcluidos?.seguro_novo).toBeUndefined();
  });

  it("FAIL-OPEN: erro ao ler sistema → segfy", async () => {
    const mod = await import("../src/services/segfy-credenciais.service");
    (mod.lerSistemaCotacao as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error("boom"),
    );
    estado.linhas = [linhaPadrao({})];
    const cfg = await obterConfigEfetiva("canal-1");
    expect(cfg?.sistema).toBe("segfy");
  });
});
