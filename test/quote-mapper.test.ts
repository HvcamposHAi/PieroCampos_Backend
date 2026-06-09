/**
 * Teste PONTUAL do mapper dinâmico:
 *  A) regra aprendida → resolve SEM chamar o LLM;
 *  B) miss → chama o LLM e grava a regra como PENDENTE;
 *  C) flag OFF → resolverEntrada cai no fallback hardcoded SEM tocar DB/LLM;
 *  + paridade de obrigatórios (faltando[]) com o hardcoded.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mapearDinamico, type MapearDinamicoDeps } from "../src/integrations/quote/mapper/dynamic-mapper";
import { resolverEntrada } from "../src/integrations/quote/mapper/dynamic-mapper.service";
import { mapearParaCotacao } from "../src/integrations/quote/mapper/legacy";
import { buildSeedSegfyAuto } from "../src/integrations/quote/mapper/seed-segfy-auto";
import { chaveRegra } from "../src/integrations/quote/mapper/rule-cache";
import type { LearnedRule } from "../src/integrations/quote/mapper/learned-rule.types";
import { _resetEnvCache } from "../src/config/env";

const CLIENTE = { cpf: "090.656.619-30", nome: "Camilly" };
const OBRIG = { cpf: "090.656.619-30", placa: "SFI7F72", cep: "81270320" };

const { schema, rules } = buildSeedSegfyAuto();
function mapaDeRegras(lista: LearnedRule[]): Map<string, LearnedRule> {
  const m = new Map<string, LearnedRule>();
  for (const r of lista) m.set(chaveRegra(r.chaveAlvo, r.entradaNormalizada), r);
  return m;
}
const CTX = { provider: "segfy", ramo: "auto", corretoraId: null, schema };

function deps(over: Partial<MapearDinamicoDeps>): MapearDinamicoDeps {
  return {
    carregarRegras: async () => mapaDeRegras(rules),
    resolverCampoComLLM: async () => ({ valor: null, confianca: 0 }),
    persistirRegraAprendida: async () => {},
    ...over,
  };
}

describe("mapearDinamico", () => {
  it("A) resolve por regra aprendida SEM chamar o LLM", async () => {
    const llm = vi.fn(async () => {
      throw new Error("LLM não deveria ser chamado");
    });
    const r = await mapearDinamico(
      { ...OBRIG, estado_civil: "casado", utilizacao_veiculo: "particular" },
      CLIENTE,
      CTX,
      deps({ resolverCampoComLLM: llm }),
    );
    expect(r.entrada?.maritalStatus).toBe("married");
    expect(r.entrada?.categoryType).toBe("particular");
    expect(r.entrada?.questionario?.utilization_type).toBe("personal");
    expect(llm).not.toHaveBeenCalled();
  });

  it("B) miss → chama o LLM e grava regra PENDENTE", async () => {
    const llm = vi.fn(async () => ({ valor: "married", confianca: 0.9 }));
    const persistir = vi.fn(async () => {});
    const r = await mapearDinamico(
      { ...OBRIG, estado_civil: "amasiado" }, // fora do mapa → miss
      CLIENTE,
      CTX,
      deps({ resolverCampoComLLM: llm, persistirRegraAprendida: persistir }),
    );
    expect(llm).toHaveBeenCalledTimes(1);
    expect(r.entrada?.maritalStatus).toBe("married");
    expect(persistir).toHaveBeenCalledTimes(1);
    const [, , , regra] = persistir.mock.calls[0];
    expect(regra).toMatchObject({ chaveAlvo: "maritalStatus", entradaNormalizada: "amasiado", origem: "llm" });
  });

  it("B2) LLM devolve value fora das opções → ignora (não grava, campo undefined)", async () => {
    const llm = vi.fn(async () => ({ valor: "inventado", confianca: 0.9 }));
    const persistir = vi.fn(async () => {});
    const r = await mapearDinamico(
      { ...OBRIG, estado_civil: "amasiado" },
      CLIENTE,
      CTX,
      deps({ resolverCampoComLLM: llm, persistirRegraAprendida: persistir }),
    );
    expect(r.entrada?.maritalStatus).toBeUndefined();
    expect(persistir).not.toHaveBeenCalled();
  });

  it("paridade de obrigatórios: placa ausente → mesmo faltando[] do hardcoded", async () => {
    const dados = { cpf: "090.656.619-30", cep: "81270320" }; // sem placa
    const din = await mapearDinamico(dados, CLIENTE, CTX, deps({}));
    const leg = mapearParaCotacao(dados, CLIENTE);
    expect(din.entrada).toBeNull();
    expect(din.faltando).toEqual(leg.faltando);
  });
});

describe("resolverEntrada (gate FAIL-CLOSED)", () => {
  beforeEach(() => {
    process.env.WA_ENABLED = "false";
    process.env.BIA_ENABLED = "false";
    process.env.MAPPER_DINAMICO_ENABLED = "false";
    _resetEnvCache();
  });

  it("C) flag OFF → fallback hardcoded, sem tocar DB/LLM", async () => {
    const carregarRegras = vi.fn(async () => new Map());
    const fallback = vi.fn(mapearParaCotacao);
    const dados = { ...OBRIG, estado_civil: "casado" };
    const r = await resolverEntrada(dados, CLIENTE, { provider: "segfy", ramo: "auto" }, fallback, deps({ carregarRegras }));
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(carregarRegras).not.toHaveBeenCalled();
    expect(r).toEqual(mapearParaCotacao(dados, CLIENTE));
  });

  it("C2) flag ON mas sem Supabase → toggle fail-closed → fallback idêntico", async () => {
    process.env.MAPPER_DINAMICO_ENABLED = "true";
    _resetEnvCache();
    const dados = { ...OBRIG, estado_civil: "solteiro" };
    const r = await resolverEntrada(dados, CLIENTE, { provider: "segfy", ramo: "auto" }, mapearParaCotacao);
    expect(r).toEqual(mapearParaCotacao(dados, CLIENTE));
  });
});
