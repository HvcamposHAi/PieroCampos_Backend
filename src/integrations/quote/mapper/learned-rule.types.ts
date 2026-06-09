/**
 * Regra APRENDIDA de mapeamento: "para o campo X, a entrada bruta Y vira o
 * value Z do provedor". É o cache determinístico do mapper.
 *
 * origem:
 *   - "seed"   → derivada das tabelas hardcoded atuais (launch byte-idêntico).
 *   - "llm"    → resolvida pelo Claude num miss; nasce `pendente` (não vale em
 *                runtime até um humano aprovar no Admin).
 *   - "humano" → criada/editada manualmente no Admin.
 */
export type OrigemRegra = "seed" | "llm" | "humano";

export interface LearnedRule {
  chaveAlvo: string;
  /** Valor bruto JÁ NORMALIZADO (lowercase/trim) de `dados_coletados`. */
  entradaNormalizada: string;
  /** Valor final no payload do provedor. */
  valorResolvido: string;
  origem: OrigemRegra;
  /** 0..1. seed/humano = 1.0; llm = score do resolver. */
  confianca: number;
}
