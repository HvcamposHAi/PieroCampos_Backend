/**
 * Tipos do módulo de formulário (questionário Excel).
 *
 * Módulo ISOLADO (estilo `src/integrations/segfy`): funções puras, sem
 * dependência de Supabase nem Baileys. Gera/parseia o .xlsx em memória.
 */
import type { CategoriaConversa } from "../../lib/roteiros";

/** Marcador na aba oculta `_meta` que identifica um questionário nosso. */
export const FORM_MAGIC = "PIERO_FORM_V1";

/** Versão atual do layout do questionário. Bump ao mudar colunas/abas. */
export const FORM_VERSAO = 1;

/** Nome da aba visível com as perguntas. */
export const ABA_QUESTIONARIO = "Questionário";

/** Nome da aba oculta com os metadados de proveniência. */
export const ABA_META = "_meta";

/**
 * Resultado de `parseQuestionarioXlsx`. `respostas` mapeia chave do roteiro →
 * valor preenchido (já trimado, sem vazios). `null` em parse significa "não é
 * um questionário nosso" — o chamador trata como documento comum.
 */
export interface RespostaFormulario {
  categoria: CategoriaConversa;
  versao: number;
  respostas: Record<string, string>;
}
