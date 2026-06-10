/**
 * Provider AUTOMATIZADO do ramo `auto` via AGGILIZADOR (segundo sistema de
 * cotação, selecionável por corretora). STUB nesta fase: a integração real
 * depende da FASE 0 de descoberta (HTTP API vs portal/RPA, 2FA?), ainda não
 * implementada em `src/integrations/aggilizador/*` + `aggilizador-cotacao.service`.
 *
 * Comportamento atual (deploy INERTE, AGGILIZADOR_ENABLED=false): cria a cotação
 * (observabilidade), registra uma etapa LEGÍVEL e retorna null → o caller escala
 * para humano (bot) ou recebe 409/erro gracioso (manual). NUNCA lança nem trava.
 *
 * Adapter FINO de propósito: quando o módulo Aggilizador existir, este arquivo só
 * passa a delegar em `dispararCotacaoAggilizador(...)` (mesma assinatura do Segfy),
 * sem o orquestrador (cotacao.service) nem o bot mudarem.
 */
import { getEnv } from "../../config/env";
import { SupabasePersistence } from "../persistence/supabase-persistence";
import type { PersistencePort } from "../segfy/persistence.port";
import type { QuoteContext, QuoteProvider, QuoteResult } from "./quote-provider.port";
import { logger } from "../../utils/logger";

export const aggilizadorAutoProvider: QuoteProvider = {
  nome: "aggilizador-auto",
  automatizado: true,
  async cotar(
    ctx: QuoteContext,
    persistInjetado?: PersistencePort,
    onIniciada?: (cotacaoId: string) => void,
  ): Promise<QuoteResult | null> {
    const persist: PersistencePort =
      persistInjetado ?? new SupabasePersistence(undefined, ctx.corretoraId);

    // Cria a cotação primeiro (observabilidade imediata; id já existe p/ a UI).
    const { cotacaoId } = await persist.iniciarCotacao({
      conversaId: ctx.conversaId,
      clienteId: ctx.clienteId,
      ramo: ctx.ramo,
      dadosEntrada: ctx.dados,
      origem: ctx.origem,
    });
    onIniciada?.(cotacaoId);

    // STUB: enquanto a integração não existe (ou está desabilitada), escala p/ humano.
    // Quando o módulo Aggilizador estiver pronto, trocar este bloco por:
    //   return dispararCotacaoAggilizador({ ...ctx }, persist, undefined);
    const habilitado = getEnv().AGGILIZADOR_ENABLED;
    await persist.registrarEtapa({
      cotacaoId,
      conversaId: ctx.conversaId,
      etapa: "token",
      status: "erro",
      mensagem: habilitado
        ? "Integração Aggilizador ainda em implementação — cotação encaminhada para o operador."
        : "Aggilizador desabilitado — cotação encaminhada para o operador.",
    });
    await persist.atualizarCotacao(cotacaoId, { status: "erro" });
    await persist.registrarLog({
      operacao: "cotacao",
      via: "api",
      refId: cotacaoId,
      sucesso: false,
      detalhe: { provider: "aggilizador-auto", habilitado, motivo: "stub" },
    });

    logger.info("[cotacao] aggilizador (stub): escalado p/ operador", {
      conversaId: ctx.conversaId,
      habilitado,
    });
    return null; // null → caller escala para humano
  },
};
