/**
 * Provider AUTOMATIZADO do ramo `auto` (Segfy). Adapter FINO sobre o fluxo
 * existente `dispararCotacaoSegfy` — comportamento byte-a-byte do auto. Manter
 * fino é o ponto: nenhuma lógica nova de cotação aqui; só tradução de tipos.
 */
import { dispararCotacaoSegfy } from "../../services/segfy-cotacao.service";
import { conexaoUtilizavel, marcarSessaoExpirada } from "../../services/segfy-sessao.service";
import { notificarReauthNecessaria } from "../../services/segfy-alertas.service";
import { SegfyReauthNecessariaError } from "../segfy/errors";
import { getEnv } from "../../config/env";
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
    // PRÉ-CHECK de conexão (choke point único de bot + manual): se o Segfy está
    // habilitado mas a sessão NÃO está utilizável (sem tokens frescos), NÃO chega
    // a criar a cotação — evita o card "parou em Autenticação no Segfy". Avisa o
    // operador (1x na transição) e LANÇA SegfyReauthNecessariaError, traduzido em:
    //  - cotação manual → HTTP 409 reauth_necessaria (front abre o modal);
    //  - bot → escala p/ humano sem card quebrado.
    // O check é DB-read (sem hit no Segfy) e fail-open (erro de leitura → tenta cotar).
    if (getEnv().SEGFY_ENABLED) {
      const { conectado } = await conexaoUtilizavel();
      if (!conectado) {
        const transicionou = await marcarSessaoExpirada();
        if (transicionou) {
          await notificarReauthNecessaria(
            "A sessão do Segfy expirou — reautentique para cotar (Admin › Segfy ou rode o agente).",
          );
        }
        throw new SegfyReauthNecessariaError();
      }
    }
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
