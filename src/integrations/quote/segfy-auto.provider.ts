/**
 * Provider AUTOMATIZADO do ramo `auto` (Segfy). Adapter FINO sobre o fluxo
 * existente `dispararCotacaoSegfy` — comportamento byte-a-byte do auto. Manter
 * fino é o ponto: nenhuma lógica nova de cotação aqui; só tradução de tipos.
 */
import { dispararCotacaoSegfy } from "../../services/segfy-cotacao.service";
import type { PersistencePort } from "../segfy/persistence.port";
import type { QuoteContext, QuoteProvider, QuoteResult } from "./quote-provider.port";

export const segfyAutoProvider: QuoteProvider = {
  nome: "segfy-auto",
  automatizado: true,
  async cotar(
    ctx: QuoteContext,
    persist?: PersistencePort,
    onIniciada?: (cotacaoId: string) => void,
  ): Promise<QuoteResult | null> {
    // ctx.ramo deve ser 'auto' aqui (o registry só roteia auto p/ este provider).
    const r = await dispararCotacaoSegfy(
      {
        conversaId: ctx.conversaId,
        clienteId: ctx.clienteId,
        dados: ctx.dados,
        origem: ctx.origem,
        corretoraId: ctx.corretoraId,
      },
      persist,
      onIniciada,
    );
    return r; // ResultadoDisparo é estruturalmente compatível com QuoteResult.
  },
};
