/**
 * Porta de PROVIDER de cotação — abstrai "qual sistema cota qual ramo".
 *
 * Hoje só o ramo `auto` tem provider AUTOMATIZADO (Segfy). Os demais ramos
 * (vida/residencial/empresarial/saúde) usam o provider NÃO-AUTOMATIZADO, que
 * apenas registra a cotação como `pendente` para o operador conduzir. Novos
 * sistemas (outros multicálculos) entram criando uma nova implementação desta
 * porta e registrando-a em `registry.ts` — sem tocar no orquestrador nem no bot.
 *
 * Reusa a `PersistencePort` do módulo Segfy (já é DB-agnóstica e genérica em
 * `ramo`). O retorno espelha o `ResultadoDisparo` do fluxo Segfy para que os
 * callers (bot.service / cotacao-manual) não mudem sua lógica de tratamento.
 */
import type { Ramo } from "../../lib/roteiros";
import type { PersistencePort } from "../segfy/persistence.port";
import type { ResultadoCotacaoItem } from "../segfy/segfy.types";

export interface QuoteContext {
  /** Corretora (tenant) dona da cotação. Omitido → corretora seed (Piero). */
  corretoraId?: string;
  /** Nulo na cotação MANUAL (sem conversa WhatsApp). */
  conversaId: string | null;
  clienteId: string;
  ramo: Ramo;
  dados: Record<string, unknown>;
  origem?: "whatsapp" | "manual";
}

/**
 * Resultado do disparo. `texto` é a mensagem pronta p/ WhatsApp (ou null quando
 * não há comparativo — caso não-automatizado). `maisBarata` é o destaque (auto).
 */
export interface QuoteResult {
  texto: string;
  cotacaoId: string | null;
  maisBarata: ResultadoCotacaoItem | null;
}

export interface QuoteProvider {
  /** Identificador legível (ex.: "segfy-auto", "nao-automatizado"). */
  readonly nome: string;
  /** true = cota sozinho (Segfy); false = só registra pendente p/ o operador. */
  readonly automatizado: boolean;
  /**
   * Dispara a cotação. Retorna null quando NÃO houve resultado utilizável
   * (integração off, dados faltando, erro) — o caller então escala para humano.
   * `onIniciada` é chamado logo após criar a cotação (id já existe).
   */
  cotar(
    ctx: QuoteContext,
    persist?: PersistencePort,
    onIniciada?: (cotacaoId: string) => void,
  ): Promise<QuoteResult | null>;
}
