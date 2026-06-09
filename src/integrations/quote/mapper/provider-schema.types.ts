/**
 * Vocabulário do SCHEMA de um provedor de cotação (genérico, sem I/O).
 *
 * Descreve, de forma editável no banco (sem deploy), QUAIS campos o provedor
 * (ex.: Segfy/auto) espera e COMO traduzir os dados coletados do cliente para
 * cada um. O mapper dinâmico consome este schema; a tela do Admin o edita; o
 * resolver LLM usa as descrições/sinônimos quando falta uma regra aprendida.
 *
 * Puro: nenhum import de runtime. Validado por Zod no schema-store na borda.
 */

/** Como o valor bruto coletado se converte no `value` aceito pelo provedor. */
export type FieldType = "string" | "number" | "boolean" | "enum" | "passthrough";

export interface EnumOption {
  /** Valor EXATO aceito pelo provedor (ex.: "single", "yes_with_electronic_gate"). */
  value: string;
  /** Descrição em linguagem natural (entra no prompt do resolver LLM). */
  descricao: string;
  /** Entradas normalizadas (lowercase/trim) que mapeiam para este value sem LLM. */
  sinonimos: string[];
}

export interface ProviderField {
  /**
   * Caminho do campo no payload do provedor. Notação ponto = aninhado.
   * Ex.: "maritalStatus", "categoryType", "questionario.residence_garage".
   */
  chaveAlvo: string;
  tipo: FieldType;
  obrigatorio: boolean;
  /** Descrição NL do campo (contexto para o resolver LLM e para a tela). */
  descricao: string;
  /** Opções válidas (para tipo "enum"): value + descrição + sinônimos. */
  opcoes?: EnumOption[];
  /**
   * Valor default do provedor quando o cliente não respondeu. Espelha o
   * QUESTIONARIO_PADRAO: o mapper OMITE o override quando cai no default, para
   * o `cotarAuto` completar a partir do padrão (paridade com o hardcoded).
   */
  default?: string | number | boolean | null;
  /** Chaves de `dados_coletados` que alimentam este campo (ordem = prioridade). */
  fontes: string[];
}

export interface ProviderSchema {
  /** Identificador do provedor (ex.: "segfy"). */
  provider: string;
  /** Ramo/produto (ex.: "auto"). */
  ramo: string;
  /** Versão do schema (cresce a cada edição relevante). */
  versao: number;
  campos: ProviderField[];
}
