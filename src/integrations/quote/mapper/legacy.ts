/**
 * Mapeador HARDCODED (legado) — fonte de verdade do comportamento ATUAL.
 *
 * Foi extraído de `segfy-cotacao.service.ts` SEM alteração de lógica para:
 *   1) servir de FALLBACK do mapper dinâmico (FAIL-CLOSED → comportamento de hoje);
 *   2) ser a fonte de SEED do schema + regras (launch byte-idêntico);
 *   3) compartilhar os helpers de coerção e os obrigatórios com o mapper dinâmico
 *      (mesma crítica de cpf/placa/cep → `faltando[]` nunca diverge).
 *
 * `segfy-cotacao.service.ts` re-exporta `mapearParaCotacao` e `EntradaMapeada`
 * daqui — o contrato público e os imports dos testes permanecem idênticos.
 */
import {
  type DadosCotacaoAuto,
  type QuestionarioSegfy,
} from "../../segfy/segfy.multicalculo";
import { cpfValido } from "../../../lib/cpf";

// ---- helpers de coerção (compartilhados com o mapper dinâmico) --------------
export function asString(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  if (typeof v === "number") return String(v);
  return undefined;
}
export function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[^\d.,-]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
export function ehSim(v: unknown): boolean | undefined {
  const s = asString(v)?.toLowerCase();
  if (s == null) return undefined;
  if (["sim", "true", "1", "yes", "tem", "possui"].includes(s)) return true;
  if (["nao", "não", "false", "0", "no", "nenhum"].includes(s)) return false;
  return undefined;
}

// ---- mapas de enum (PT → Segfy) — ✅ CONFIRMADOS no bundle do form (30/05/2026).
export const MAP_ESTADO_CIVIL: Record<string, string> = {
  solteiro: "single",
  casado: "married", // "Casado(a) ou união estável"
  uniao_estavel: "married",
  divorciado: "divorced",
  separado: "divorced",
  viuvo: "widower", // ✓ é "widower" (não "widowed")
};
/** uso → { category_type, utilization_type }. utilization: personal|job|both. */
export const MAP_USO: Record<string, { category_type: string; utilization_type: string }> = {
  particular: { category_type: "particular", utilization_type: "personal" },
  trabalho: { category_type: "particular", utilization_type: "personal" },
  comercial: { category_type: "particular", utilization_type: "job" },
  aplicativo: { category_type: "app_transport", utilization_type: "both" },
  app: { category_type: "app_transport", utilization_type: "both" },
  uber: { category_type: "app_transport", utilization_type: "both" },
  taxi: { category_type: "taxi", utilization_type: "both" },
};
export const MAP_RESIDENCIA: Record<string, string> = {
  casa: "house",
  apartamento: "apartment",
  ap: "apartment",
  condominio: "condominium",
  chacara: "farm",
  sitio: "farm",
};

/** Extrai a placa de um campo `placa` ou do texto livre `dados_veiculo_fipe`. */
export function extrairPlaca(dados: Record<string, unknown>): string | undefined {
  const direto = asString(dados.placa);
  const texto = `${direto ?? ""} ${asString(dados.dados_veiculo_fipe) ?? ""}`;
  const achado = /([A-Za-z]{3}[-\s]?\d[A-Za-z0-9]\d{2})/.exec(texto.replace(/\s+/g, " "))?.[1];
  return achado ? achado.replace(/[-\s]/g, "").toUpperCase() : undefined;
}

export interface EntradaMapeada {
  entrada: DadosCotacaoAuto | null;
  faltando: string[];
}

/**
 * Resolve os campos OBRIGATÓRIOS (cpf/placa/cep) com a MESMA crítica do legado.
 * Compartilhado pelo mapper dinâmico para que `faltando[]` nunca divirja.
 */
export interface Obrigatorios {
  cpf?: string;
  placa?: string;
  cep?: string;
  faltando: string[];
}
export function extrairObrigatorios(
  dados: Record<string, unknown>,
  cliente: { cpf: string | null },
): Obrigatorios {
  const faltando: string[] = [];
  const cpfBruto = asString(dados.cpf) ?? asString(dados.cpf_cnpj) ?? asString(cliente.cpf);
  const cpf = cpfBruto?.replace(/\D/g, "");
  const placa = extrairPlaca(dados);
  const cep = asString(dados.cep) ?? asString(dados.endereco);
  if (!cpf) faltando.push("cpf");
  else if (!cpfValido(cpf)) faltando.push("cpf (inválido)");
  if (!placa) faltando.push("placa do veículo");
  if (!cep) faltando.push("cep");
  return { cpf, placa, cep, faltando };
}

/**
 * Mapeia `dados_coletados` + cliente → entrada do Segfy, aplicando as árvores de
 * decisão. PURO (sem I/O) — coberto por teste.
 */
export function mapearParaCotacao(
  dados: Record<string, unknown>,
  cliente: { cpf: string | null; nome?: string | null },
): EntradaMapeada {
  const { cpf, placa, cep, faltando } = extrairObrigatorios(dados, cliente);
  if (faltando.length > 0 || !cpf || !placa || !cep) return { entrada: null, faltando };

  // Questionário (árvores de decisão) — só sobrescreve o padrão quando há resposta.
  const q: Partial<QuestionarioSegfy> = {};
  // Garagem na residência: sim → portão eletrônico (default do form); não → não possui.
  const garagemCasa = ehSim(dados.garagem) ?? ehSim(dados.garagem_residencia);
  if (garagemCasa === true) q.residence_garage = "yes_with_electronic_gate";
  else if (garagemCasa === false) q.residence_garage = "no_garage";
  // Trabalho: não trabalha → does_not_work; trabalha → garagem? yes/no.
  const trabalha = ehSim(dados.trabalha);
  if (trabalha === false) q.job_garage = "does_not_work";
  else if (trabalha === true) q.job_garage = ehSim(dados.garagem_trabalho) ? "yes" : "no";
  // Estudo: não estuda → does_not_study; estuda → garagem? yes/no.
  const estuda = ehSim(dados.estuda);
  if (estuda === false) q.study_garage = "does_not_study";
  else if (estuda === true) q.study_garage = ehSim(dados.garagem_estudo) ? "yes" : "no";
  const kmMes = asNumber(dados.km_mes);
  if (kmMes != null) q.monthly_km = String(kmMes);
  const dist = asNumber(dados.distancia_trabalho);
  if (dist != null) q.work_distance = String(dist);
  const tipoResid = asString(dados.tipo_residencia)?.toLowerCase();
  if (tipoResid && MAP_RESIDENCIA[tipoResid]) q.residence_type = MAP_RESIDENCIA[tipoResid];
  // "Reside com condutores de 18 a 26 anos?" → does_not_exist | yes_female | yes_male | yes_both.
  const condutorJovem = ehSim(dados.condutor_jovem) ?? ehSim(dados.outro_condutor);
  if (condutorJovem === false) q.other_driver = "does_not_exist";
  else if (condutorJovem === true) {
    const sexo = asString(dados.sexo_condutor_jovem)?.toLowerCase();
    q.other_driver = sexo?.startsWith("f") ? "yes_female" : sexo?.startsWith("m") ? "yes_male" : "yes_both";
    const idade = asNumber(dados.idade_condutor_secundario);
    q.secondary_driver_age = idade != null && idade >= 25 ? "age_25" : "age_18_to_24";
  }
  // Isenção fiscal (PCD). ipi/icms só p/ taxi/app — não tratamos aqui.
  if (ehSim(dados.pcd) === true) q.tax_exemption = "pcd_isent";

  // uso → category_type / utilization_type
  const usoKey = asString(dados.utilizacao_veiculo)?.toLowerCase();
  const uso = usoKey ? MAP_USO[usoKey] : undefined;
  if (uso) q.utilization_type = uso.utilization_type;

  const estadoCivilKey = asString(dados.estado_civil)?.toLowerCase();

  const entrada: DadosCotacaoAuto = {
    cpf,
    placa,
    cep: cep.replace(/\D/g, ""),
    profissao: asString(dados.profissao),
    maritalStatus: estadoCivilKey ? MAP_ESTADO_CIVIL[estadoCivilKey] : undefined,
    categoryType: uso?.category_type,
    bonus: asNumber(dados.bonus),
    questionario: Object.keys(q).length ? q : undefined,
  };
  return { entrada, faltando: [] };
}
