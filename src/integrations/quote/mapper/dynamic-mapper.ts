/**
 * Mapper DINÂMICO do auto/Segfy. Mesma forma de retorno que `mapearParaCotacao`
 * (legacy) e MESMO fluxo de controle (árvores de decisão) — a diferença é que os
 * valores de enum NÃO são literais hardcoded: vêm de `resolver()`:
 *   (1) regra aprendida ativa → (2) sinônimo do schema → (3) LLM (cacheia
 *   pendente) → (4) undefined (cai no default/omite o campo, como o legacy).
 *
 * ⚠️ MANTER linha-a-linha paralelo a `legacy.mapearParaCotacao`: o teste E2E de
 * paridade (flag on×off) garante que, com as regras semeadas, a saída é idêntica.
 *
 * Os helpers de coerção e os obrigatórios (cpf/placa/cep) são compartilhados com
 * o legacy (mesma crítica → `faltando[]` nunca diverge).
 */
import type { DadosCotacaoAuto, QuestionarioSegfy } from "../../segfy/segfy.multicalculo";
import {
  asNumber,
  asString,
  ehSim,
  extrairObrigatorios,
  type EntradaMapeada,
} from "./legacy";
import { CHAVE, TOK } from "./auto-tokens";
import { carregarRegras as carregarRegrasPadrao, persistirRegraAprendida as persistirPadrao } from "./rule-cache";
import { resolverCampoComLLM as resolverLLMPadrao } from "./field-resolver.llm";
import { chaveRegra } from "./rule-cache";
import type { ProviderSchema } from "./provider-schema.types";

/** Teto de campos resolvidos via LLM por cotação (limita custo/latência no miss). */
const MAX_LLM_POR_COTACAO = 6;

/** Dependências injetáveis (testes substituem sem vi.mock). */
export interface MapearDinamicoDeps {
  carregarRegras: typeof carregarRegrasPadrao;
  resolverCampoComLLM: typeof resolverLLMPadrao;
  persistirRegraAprendida: typeof persistirPadrao;
}
const DEPS_PADRAO: MapearDinamicoDeps = {
  carregarRegras: carregarRegrasPadrao,
  resolverCampoComLLM: resolverLLMPadrao,
  persistirRegraAprendida: persistirPadrao,
};

export interface DynamicCtx {
  provider: string;
  ramo: string;
  corretoraId: string | null;
  schema: ProviderSchema;
}

export async function mapearDinamico(
  dados: Record<string, unknown>,
  cliente: { cpf: string | null; nome?: string | null },
  ctx: DynamicCtx,
  deps: MapearDinamicoDeps = DEPS_PADRAO,
): Promise<EntradaMapeada> {
  const { cpf, placa, cep, faltando } = extrairObrigatorios(dados, cliente);
  if (faltando.length > 0 || !cpf || !placa || !cep) return { entrada: null, faltando };

  const regras = await deps.carregarRegras(ctx.provider, ctx.ramo, ctx.corretoraId);
  let llmRestantes = MAX_LLM_POR_COTACAO;

  /** Resolve o value do provedor para (chaveAlvo, entradaNorm). undefined = não resolvido. */
  const resolver = async (chaveAlvo: string, entradaNorm: string | undefined): Promise<string | undefined> => {
    if (entradaNorm == null || entradaNorm === "") return undefined;
    const regra = regras.get(chaveRegra(chaveAlvo, entradaNorm));
    if (regra) return regra.valorResolvido;

    const campo = ctx.schema.campos.find((c) => c.chaveAlvo === chaveAlvo);
    if (!campo) return undefined;
    // Sinônimo declarado no schema (sem custo de LLM).
    const sinonimo = campo.opcoes?.find((o) =>
      o.sinonimos.some((s) => s.toLowerCase() === entradaNorm),
    );
    if (sinonimo) return sinonimo.value;
    // Miss → LLM (limitado por cotação); resultado vira regra PENDENTE.
    if (llmRestantes <= 0) return undefined;
    llmRestantes--;
    const out = await deps.resolverCampoComLLM({ campo, valorBruto: entradaNorm, dados });
    if (out.valor && campo.opcoes?.some((o) => o.value === out.valor)) {
      await deps.persistirRegraAprendida(ctx.provider, ctx.ramo, ctx.corretoraId, {
        chaveAlvo,
        entradaNormalizada: entradaNorm,
        valorResolvido: out.valor,
        origem: "llm",
        confianca: out.confianca,
      });
      return out.valor;
    }
    return undefined;
  };

  const q: Partial<QuestionarioSegfy> = {};

  // Garagem na residência.
  const garagemCasa = ehSim(dados.garagem) ?? ehSim(dados.garagem_residencia);
  if (garagemCasa === true) {
    const v = await resolver(CHAVE.residenceGarage, TOK.garagem.sim);
    if (v) q.residence_garage = v;
  } else if (garagemCasa === false) {
    const v = await resolver(CHAVE.residenceGarage, TOK.garagem.nao);
    if (v) q.residence_garage = v;
  }
  // Trabalho.
  const trabalha = ehSim(dados.trabalha);
  if (trabalha === false) {
    const v = await resolver(CHAVE.jobGarage, TOK.trabalho.nao);
    if (v) q.job_garage = v;
  } else if (trabalha === true) {
    const tok = ehSim(dados.garagem_trabalho) ? TOK.trabalho.com : TOK.trabalho.sem;
    const v = await resolver(CHAVE.jobGarage, tok);
    if (v) q.job_garage = v;
  }
  // Estudo.
  const estuda = ehSim(dados.estuda);
  if (estuda === false) {
    const v = await resolver(CHAVE.studyGarage, TOK.estudo.nao);
    if (v) q.study_garage = v;
  } else if (estuda === true) {
    const tok = ehSim(dados.garagem_estudo) ? TOK.estudo.com : TOK.estudo.sem;
    const v = await resolver(CHAVE.studyGarage, tok);
    if (v) q.study_garage = v;
  }
  // Quilometragem / distância (passthrough numérico — idêntico ao legacy).
  const kmMes = asNumber(dados.km_mes);
  if (kmMes != null) q.monthly_km = String(kmMes);
  const dist = asNumber(dados.distancia_trabalho);
  if (dist != null) q.work_distance = String(dist);
  // Tipo de residência (enum PT direto).
  const tipoResid = asString(dados.tipo_residencia)?.toLowerCase();
  if (tipoResid) {
    const v = await resolver(CHAVE.residenceType, tipoResid);
    if (v) q.residence_type = v;
  }
  // Condutor jovem (18-26) → other_driver + secondary_driver_age.
  const condutorJovem = ehSim(dados.condutor_jovem) ?? ehSim(dados.outro_condutor);
  if (condutorJovem === false) {
    const v = await resolver(CHAVE.otherDriver, TOK.condutor.nao);
    if (v) q.other_driver = v;
  } else if (condutorJovem === true) {
    const sexo = asString(dados.sexo_condutor_jovem)?.toLowerCase();
    const tokSexo = sexo?.startsWith("f") ? TOK.condutor.f : sexo?.startsWith("m") ? TOK.condutor.m : TOK.condutor.indef;
    const v = await resolver(CHAVE.otherDriver, tokSexo);
    if (v) q.other_driver = v;
    const idade = asNumber(dados.idade_condutor_secundario);
    const tokIdade = idade != null && idade >= 25 ? TOK.idade.ge25 : TOK.idade.lt25;
    const va = await resolver(CHAVE.secondaryDriverAge, tokIdade);
    if (va) q.secondary_driver_age = va;
  }
  // Isenção fiscal (PCD).
  if (ehSim(dados.pcd) === true) {
    const v = await resolver(CHAVE.taxExemption, TOK.pcd.sim);
    if (v) q.tax_exemption = v;
  }
  // Uso → categoryType / utilization_type (enum PT direto).
  const usoKey = asString(dados.utilizacao_veiculo)?.toLowerCase();
  if (usoKey) {
    const ut = await resolver(CHAVE.utilizationType, usoKey);
    if (ut) q.utilization_type = ut;
  }
  const categoryType = usoKey ? await resolver(CHAVE.categoryType, usoKey) : undefined;

  const estadoCivilKey = asString(dados.estado_civil)?.toLowerCase();
  const maritalStatus = estadoCivilKey ? await resolver(CHAVE.maritalStatus, estadoCivilKey) : undefined;

  const entrada: DadosCotacaoAuto = {
    cpf,
    placa,
    cep: cep.replace(/\D/g, ""),
    profissao: asString(dados.profissao),
    maritalStatus,
    categoryType,
    bonus: asNumber(dados.bonus),
    questionario: Object.keys(q).length ? q : undefined,
  };
  return { entrada, faltando: [] };
}
