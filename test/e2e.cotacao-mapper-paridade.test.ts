/**
 * E2E de PARIDADE (regressão zero): para um conjunto de fixtures que cobre TODOS
 * os branches do roteiro auto, o mapper DINÂMICO (com as regras semeadas em
 * memória) produz um DadosCotacaoAuto DEEP-EQUAL ao hardcoded (mapearParaCotacao).
 *
 * Prova que o SEED reproduz o comportamento atual byte-a-byte — ligar o mapeamento
 * dinâmico não muda nenhuma cotação para entradas conhecidas.
 */
import { describe, it, expect } from "vitest";
import { mapearDinamico } from "../src/integrations/quote/mapper/dynamic-mapper";
import { mapearParaCotacao } from "../src/integrations/quote/mapper/legacy";
import { buildSeedSegfyAuto } from "../src/integrations/quote/mapper/seed-segfy-auto";
import { chaveRegra } from "../src/integrations/quote/mapper/rule-cache";
import type { LearnedRule } from "../src/integrations/quote/mapper/learned-rule.types";

const CLIENTE = { cpf: "090.656.619-30", nome: "Camilly" };
const OBRIG = { cpf: "090.656.619-30", placa: "SFI7F72", cep: "81270320" };

const { schema, rules } = buildSeedSegfyAuto();
const mapaRegras = new Map<string, LearnedRule>();
for (const r of rules) mapaRegras.set(chaveRegra(r.chaveAlvo, r.entradaNormalizada), r);

const CTX = { provider: "segfy", ramo: "auto", corretoraId: null, schema };
// Deps que NUNCA chamam o LLM (seed cobre tudo); se chamar, o teste falha.
const DEPS = {
  carregarRegras: async () => mapaRegras,
  resolverCampoComLLM: async () => {
    throw new Error("LLM chamado no caminho semeado (divergência de seed!)");
  },
  persistirRegraAprendida: async () => {},
};

// --- matriz de fixtures cobrindo todos os branches ---------------------------
const fixtures: Array<Record<string, unknown>> = [];
const add = (extra: Record<string, unknown>) => fixtures.push({ ...OBRIG, ...extra });

add({}); // nada respondido (questionario undefined)
for (const ec of ["solteiro", "casado", "uniao_estavel", "divorciado", "separado", "viuvo"]) add({ estado_civil: ec });
for (const u of ["particular", "trabalho", "comercial", "aplicativo", "app", "uber", "taxi"]) add({ utilizacao_veiculo: u });
for (const tr of ["casa", "apartamento", "ap", "condominio", "chacara", "sitio"]) add({ tipo_residencia: tr });
add({ garagem: "sim" });
add({ garagem: "nao" });
add({ garagem_residencia: "sim" });
add({ trabalha: "nao" });
add({ trabalha: "sim", garagem_trabalho: "sim" });
add({ trabalha: "sim", garagem_trabalho: "nao" });
add({ trabalha: "sim" }); // garagem_trabalho ausente → "no"
add({ estuda: "nao" });
add({ estuda: "sim", garagem_estudo: "sim" });
add({ estuda: "sim", garagem_estudo: "nao" });
add({ condutor_jovem: "nao" });
add({ condutor_jovem: "sim", sexo_condutor_jovem: "feminino", idade_condutor_secundario: "20" });
add({ condutor_jovem: "sim", sexo_condutor_jovem: "masculino", idade_condutor_secundario: "30" });
add({ condutor_jovem: "sim", idade_condutor_secundario: "25" }); // sexo ausente → yes_both, age_25
add({ outro_condutor: "sim", sexo_condutor_jovem: "f" });
add({ pcd: "sim" });
add({ pcd: "nao" });
add({ km_mes: "1200", distancia_trabalho: "15", bonus: "7", profissao: "Engenheiro" });
// kitchen sink
add({
  estado_civil: "casado",
  utilizacao_veiculo: "uber",
  tipo_residencia: "apartamento",
  garagem: "sim",
  trabalha: "sim",
  garagem_trabalho: "nao",
  estuda: "sim",
  garagem_estudo: "sim",
  condutor_jovem: "sim",
  sexo_condutor_jovem: "masculino",
  idade_condutor_secundario: "22",
  pcd: "sim",
  km_mes: "800",
  distancia_trabalho: "10",
  bonus: "5",
  profissao: "Médico",
});

describe("paridade dinâmico × hardcoded (auto)", () => {
  it.each(fixtures.map((f, i) => [i, f] as const))(
    "fixture #%i produz DadosCotacaoAuto idêntico",
    async (_i, dados) => {
      const legado = mapearParaCotacao(dados, CLIENTE);
      const dinamico = await mapearDinamico(dados, CLIENTE, CTX, DEPS);
      expect(dinamico).toEqual(legado);
    },
  );
});
