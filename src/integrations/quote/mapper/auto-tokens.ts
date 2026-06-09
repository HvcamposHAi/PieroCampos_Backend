/**
 * ÚNICA fonte das `chaveAlvo` e das `entrada_normalizada` (tokens) usadas pelo
 * mapeamento dinâmico do auto/Segfy.
 *
 * O `dynamic-mapper` COMPUTA estes tokens a partir das árvores de decisão; o
 * `seed-segfy-auto` cria as regras com EXATAMENTE os mesmos tokens. Importar de
 * um só lugar garante que o lookup e o seed nunca divergem.
 *
 * - Campos de enum simples (maritalStatus, categoryType, residence_type,
 *   utilization_type): o token É o valor PT em minúsculas (estado_civil/uso/
 *   tipo_residencia) — o seed mapeia direto das tabelas MAP_*.
 * - Campos ESTRUTURAIS (garagens, condutor, idade, isenção): o token representa
 *   o RESULTADO do branch (não há entrada PT única); o seed mapeia token→value.
 */

/** Caminhos de campo no payload (notação ponto = aninhado em `questionario`). */
export const CHAVE = {
  maritalStatus: "maritalStatus",
  categoryType: "categoryType",
  utilizationType: "questionario.utilization_type",
  residenceType: "questionario.residence_type",
  residenceGarage: "questionario.residence_garage",
  jobGarage: "questionario.job_garage",
  studyGarage: "questionario.study_garage",
  otherDriver: "questionario.other_driver",
  secondaryDriverAge: "questionario.secondary_driver_age",
  taxExemption: "questionario.tax_exemption",
} as const;

/** Tokens de entrada_normalizada para os campos estruturais (árvores). */
export const TOK = {
  garagem: { sim: "garagem:sim", nao: "garagem:nao" },
  trabalho: { nao: "trabalho:nao", com: "trabalho:com_garagem", sem: "trabalho:sem_garagem" },
  estudo: { nao: "estudo:nao", com: "estudo:com_garagem", sem: "estudo:sem_garagem" },
  condutor: { nao: "condutor:nao", f: "condutor:f", m: "condutor:m", indef: "condutor:indef" },
  idade: { ge25: "idade:>=25", lt25: "idade:<25" },
  pcd: { sim: "pcd:sim" },
} as const;
