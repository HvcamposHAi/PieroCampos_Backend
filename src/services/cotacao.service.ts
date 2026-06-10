/**
 * Orquestrador de cotação (multi-ramo, multi-provider). Ponto de seleção ÚNICO:
 * resolve o provider por `ramo` + `sistema` da corretora (resolveProvider) e
 * delega. Os callers (bot.service e cotacao-manual) chamam `dispararCotacao` em
 * vez de `dispararCotacaoSegfy` diretamente — assim auto vai ao sistema escolhido
 * pela corretora (Segfy por padrão, Aggilizador se configurado) e os demais ramos
 * caem no provider não-automatizado, sem o bot conhecer detalhes de cada sistema.
 */
import { resolveProvider } from "../integrations/quote/registry";
import type { QuoteContext, QuoteResult } from "../integrations/quote/quote-provider.port";
import type { PersistencePort } from "../integrations/segfy/persistence.port";
import { normalizarRamo, type Ramo } from "../lib/roteiros";

export interface DispararCotacaoParams {
  conversaId: string | null;
  clienteId: string;
  dados: Record<string, unknown>;
  /** Ramo da cotação (default 'auto'). Define o provider. */
  ramo?: Ramo | string | null;
  origem?: "whatsapp" | "manual";
  corretoraId?: string;
}

/**
 * Dispara a cotação pelo provider do ramo. Retorna null quando não houve
 * resultado utilizável (o caller escala para humano). `onIniciada` é chamado
 * logo após criar a cotação (id já existe).
 */
export async function dispararCotacao(
  params: DispararCotacaoParams,
  persist?: PersistencePort,
  onIniciada?: (cotacaoId: string) => void,
): Promise<QuoteResult | null> {
  const ramo = normalizarRamo(params.ramo);
  const ctx: QuoteContext = {
    corretoraId: params.corretoraId,
    conversaId: params.conversaId,
    clienteId: params.clienteId,
    ramo,
    dados: params.dados,
    origem: params.origem,
  };
  const provider = await resolveProvider(params.corretoraId, ramo);
  return provider.cotar(ctx, persist, onIniciada);
}
