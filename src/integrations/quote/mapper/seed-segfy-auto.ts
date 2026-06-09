/**
 * SEED do schema + regras do auto/Segfy — derivado DETERMINISTICAMENTE das
 * tabelas hardcoded (MAP_* do legacy) + QUESTIONARIO_PADRAO + os literais das
 * árvores de decisão. Garante LAUNCH BYTE-IDÊNTICO: toda entrada que o legacy
 * traduz vira uma regra `seed/ativo` com o mesmo value → o mapper dinâmico nunca
 * chega ao LLM para os casos já cobertos.
 *
 * Puro (sem I/O). O script `print-mapper-seed.ts` imprime os INSERT a partir
 * daqui; o teste de paridade usa o mesmo build em memória.
 */
import { MAP_ESTADO_CIVIL, MAP_RESIDENCIA, MAP_USO } from "./legacy";
import { QUESTIONARIO_PADRAO } from "../../segfy/segfy.multicalculo";
import { CHAVE, TOK } from "./auto-tokens";
import type { EnumOption, ProviderField, ProviderSchema } from "./provider-schema.types";
import type { LearnedRule } from "./learned-rule.types";

export const SEED_PROVIDER = "segfy";
export const SEED_RAMO = "auto";

function regra(chaveAlvo: string, entrada: string, valor: string): LearnedRule {
  return { chaveAlvo, entradaNormalizada: entrada, valorResolvido: valor, origem: "seed", confianca: 1 };
}

/** Campo enum + regras a partir de um mapa PT(key)→value (estado_civil/uso/residência). */
function deMapaPt(
  chaveAlvo: string,
  mapa: Record<string, string>,
  descricaoCampo: string,
  descricoesValor: Record<string, string>,
  fontes: string[],
): { campo: ProviderField; rules: LearnedRule[] } {
  // Agrupa as chaves PT por value de destino → sinônimos + uma regra por chave.
  const porValor = new Map<string, string[]>();
  for (const [pt, val] of Object.entries(mapa)) {
    const arr = porValor.get(val) ?? [];
    arr.push(pt);
    porValor.set(val, arr);
  }
  const opcoes: EnumOption[] = [...porValor.entries()].map(([value, sinonimos]) => ({
    value,
    descricao: descricoesValor[value] ?? value,
    sinonimos,
  }));
  const rules = Object.entries(mapa).map(([pt, val]) => regra(chaveAlvo, pt, val));
  return {
    campo: { chaveAlvo, tipo: "enum", obrigatorio: false, descricao: descricaoCampo, opcoes, fontes },
    rules,
  };
}

/** Campo enum ESTRUTURAL + regras a partir de pares [token, value, descrição]. */
function estrutural(
  chaveAlvo: string,
  pares: Array<[token: string, value: string, descricao: string]>,
  defaultValor: string,
  descricaoCampo: string,
  fontes: string[],
): { campo: ProviderField; rules: LearnedRule[] } {
  const opcoes: EnumOption[] = pares.map(([, value, descricao]) => ({ value, descricao, sinonimos: [] }));
  const rules = pares.map(([token, value]) => regra(chaveAlvo, token, value));
  return {
    campo: { chaveAlvo, tipo: "enum", obrigatorio: false, descricao: descricaoCampo, default: defaultValor, opcoes, fontes },
    rules,
  };
}

export function buildSeedSegfyAuto(): { schema: ProviderSchema; rules: LearnedRule[] } {
  const campos: ProviderField[] = [];
  const rules: LearnedRule[] = [];
  const add = (x: { campo: ProviderField; rules: LearnedRule[] }) => {
    campos.push(x.campo);
    rules.push(...x.rules);
  };

  add(
    deMapaPt(
      CHAVE.maritalStatus,
      MAP_ESTADO_CIVIL,
      "Estado civil do segurado.",
      {
        single: "Solteiro(a)",
        married: "Casado(a) ou união estável",
        divorced: "Divorciado(a) ou separado(a)",
        widower: "Viúvo(a)",
      },
      ["estado_civil"],
    ),
  );

  // Uso do veículo → DOIS campos acoplados (category_type e utilization_type),
  // cada um com regras chaveadas no mesmo valor PT de `utilizacao_veiculo`.
  const mapCategory: Record<string, string> = {};
  const mapUtilization: Record<string, string> = {};
  for (const [pt, par] of Object.entries(MAP_USO)) {
    mapCategory[pt] = par.category_type;
    mapUtilization[pt] = par.utilization_type;
  }
  add(
    deMapaPt(
      CHAVE.categoryType,
      mapCategory,
      "Categoria de uso do veículo (particular, transporte por app, táxi).",
      { particular: "Uso particular", app_transport: "Transporte por aplicativo", taxi: "Táxi" },
      ["utilizacao_veiculo"],
    ),
  );
  add(
    deMapaPt(
      CHAVE.utilizationType,
      mapUtilization,
      "Forma de utilização do veículo.",
      { personal: "Pessoal", job: "Trabalho", both: "Pessoal e trabalho" },
      ["utilizacao_veiculo"],
    ),
  );

  add(
    deMapaPt(
      CHAVE.residenceType,
      MAP_RESIDENCIA,
      "Tipo de residência do segurado.",
      { house: "Casa", apartment: "Apartamento", condominium: "Condomínio fechado", farm: "Chácara/sítio" },
      ["tipo_residencia"],
    ),
  );

  add(
    estrutural(
      CHAVE.residenceGarage,
      [
        [TOK.garagem.sim, "yes_with_electronic_gate", "Possui garagem (com portão eletrônico)."],
        [TOK.garagem.nao, "no_garage", "Não possui garagem na residência."],
      ],
      QUESTIONARIO_PADRAO.residence_garage,
      "Garagem na residência.",
      ["garagem", "garagem_residencia"],
    ),
  );
  add(
    estrutural(
      CHAVE.jobGarage,
      [
        [TOK.trabalho.nao, "does_not_work", "Não trabalha."],
        [TOK.trabalho.com, "yes", "Trabalha e tem garagem no trabalho."],
        [TOK.trabalho.sem, "no", "Trabalha e não tem garagem no trabalho."],
      ],
      QUESTIONARIO_PADRAO.job_garage,
      "Garagem no local de trabalho.",
      ["trabalha", "garagem_trabalho"],
    ),
  );
  add(
    estrutural(
      CHAVE.studyGarage,
      [
        [TOK.estudo.nao, "does_not_study", "Não estuda."],
        [TOK.estudo.com, "yes", "Estuda e tem garagem no local de estudo."],
        [TOK.estudo.sem, "no", "Estuda e não tem garagem no local de estudo."],
      ],
      QUESTIONARIO_PADRAO.study_garage,
      "Garagem no local de estudo.",
      ["estuda", "garagem_estudo"],
    ),
  );
  add(
    estrutural(
      CHAVE.otherDriver,
      [
        [TOK.condutor.nao, "does_not_exist", "Não reside com condutores de 18 a 26 anos."],
        [TOK.condutor.f, "yes_female", "Reside com condutora jovem (feminino)."],
        [TOK.condutor.m, "yes_male", "Reside com condutor jovem (masculino)."],
        [TOK.condutor.indef, "yes_both", "Reside com condutores jovens (sexo não informado)."],
      ],
      QUESTIONARIO_PADRAO.other_driver,
      "Condutores jovens (18-26) na residência.",
      ["condutor_jovem", "outro_condutor", "sexo_condutor_jovem"],
    ),
  );
  add(
    estrutural(
      CHAVE.secondaryDriverAge,
      [
        [TOK.idade.ge25, "age_25", "Condutor secundário com 25 anos ou mais."],
        [TOK.idade.lt25, "age_18_to_24", "Condutor secundário entre 18 e 24 anos."],
      ],
      QUESTIONARIO_PADRAO.secondary_driver_age,
      "Idade do condutor secundário.",
      ["idade_condutor_secundario"],
    ),
  );
  add(
    estrutural(
      CHAVE.taxExemption,
      [[TOK.pcd.sim, "pcd_isent", "Isenção fiscal por PCD."]],
      QUESTIONARIO_PADRAO.tax_exemption,
      "Isenção fiscal (PCD).",
      ["pcd"],
    ),
  );

  // Passthrough (sem regras): listados para visibilidade/edição no Admin.
  campos.push(
    { chaveAlvo: "profissao", tipo: "passthrough", obrigatorio: false, descricao: "Profissão do segurado.", fontes: ["profissao"] },
    { chaveAlvo: "bonus", tipo: "number", obrigatorio: false, descricao: "Bônus de classe (0-10).", fontes: ["bonus"] },
    { chaveAlvo: "questionario.monthly_km", tipo: "passthrough", obrigatorio: false, descricao: "Quilometragem mensal.", default: QUESTIONARIO_PADRAO.monthly_km, fontes: ["km_mes"] },
    { chaveAlvo: "questionario.work_distance", tipo: "passthrough", obrigatorio: false, descricao: "Distância até o trabalho (km).", default: QUESTIONARIO_PADRAO.work_distance, fontes: ["distancia_trabalho"] },
  );

  return { schema: { provider: SEED_PROVIDER, ramo: SEED_RAMO, versao: 1, campos }, rules };
}
