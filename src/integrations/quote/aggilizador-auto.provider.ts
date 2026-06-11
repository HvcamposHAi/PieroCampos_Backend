/**
 * Provider AUTOMATIZADO do ramo `auto` via AGGILIZADOR (segundo sistema de
 * cotação, selecionável por corretora em `segfy_credenciais.sistema`).
 *
 * Adapter FINO sobre `dispararCotacaoAggilizador` — nenhuma lógica de cotação
 * aqui, só tradução de tipos (igual ao `segfy-auto.provider`). O orquestrador
 * (`cotacao.service`) e o bot não conhecem detalhes do Aggilizador.
 *
 * Deploy INERTE: o orquestrador só roteia para cá quando a corretora tem
 * `sistema='aggilizador'`; e mesmo aí, com `AGGILIZADOR_ENABLED=false` o serviço
 * falha graciosamente (etapa de erro legível, retorna null → escala p/ humano),
 * sem crash. NÃO há pré-check de sessão/2FA (Aggilizador é stateless, sem 2FA).
 */
import { dispararCotacaoAggilizador } from "../../services/aggilizador-cotacao.service";
import type { PersistencePort } from "../segfy/persistence.port";
import type { QuoteContext, QuoteProvider, QuoteResult } from "./quote-provider.port";

export const aggilizadorAutoProvider: QuoteProvider = {
  nome: "aggilizador-auto",
  automatizado: true,
  async cotar(
    ctx: QuoteContext,
    persist?: PersistencePort,
    onIniciada?: (cotacaoId: string) => void,
  ): Promise<QuoteResult | null> {
    // ctx.ramo deve ser 'auto' aqui (o registry só roteia auto p/ este provider).
    return dispararCotacaoAggilizador(
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
  },
};
