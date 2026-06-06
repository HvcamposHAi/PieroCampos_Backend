/**
 * Provider NÃO-AUTOMATIZADO — usado por todos os ramos sem integração de
 * multicálculo (vida/residencial/empresarial/saúde). NÃO chama sistema externo:
 * apenas registra a cotação como `pendente` (com os dados coletados) e marca as
 * etapas, para que ela apareça em "Cotações pendentes" no board /chamados e o
 * OPERADOR conduza manualmente. Escopo desta entrega (premissa P5): cotação
 * automatizada de ramos não-auto fica para um provider futuro.
 */
import { SupabasePersistence } from "../persistence/supabase-persistence";
import type { PersistencePort } from "../segfy/persistence.port";
import type { QuoteContext, QuoteProvider, QuoteResult } from "./quote-provider.port";
import { logger } from "../../utils/logger";

export const naoAutomatizadoProvider: QuoteProvider = {
  nome: "nao-automatizado",
  automatizado: false,
  async cotar(
    ctx: QuoteContext,
    persistInjetado?: PersistencePort,
    onIniciada?: (cotacaoId: string) => void,
  ): Promise<QuoteResult | null> {
    const persist: PersistencePort =
      persistInjetado ?? new SupabasePersistence(undefined, ctx.corretoraId);

    // Cria a cotação (observabilidade imediata) e marca como pendente p/ operador.
    const { cotacaoId } = await persist.iniciarCotacao({
      conversaId: ctx.conversaId,
      clienteId: ctx.clienteId,
      ramo: ctx.ramo,
      dadosEntrada: ctx.dados,
      origem: ctx.origem,
    });
    onIniciada?.(cotacaoId);

    await persist.registrarEtapa({
      cotacaoId,
      conversaId: ctx.conversaId,
      etapa: "coleta",
      status: "ok",
      mensagem: `Dados coletados (ramo ${ctx.ramo}). Cotação encaminhada para análise do operador (sem cotação automática).`,
    });
    await persist.atualizarCotacao(cotacaoId, { status: "pendente" });
    await persist.registrarLog({
      operacao: "cotacao",
      via: "api",
      refId: cotacaoId,
      sucesso: true,
      detalhe: { ramo: ctx.ramo, automatizado: false },
    });

    logger.info("[cotacao] ramo não-auto: cotação pendente p/ operador", {
      conversaId: ctx.conversaId,
      ramo: ctx.ramo,
    });

    // texto informativo (NÃO é enviado automaticamente ao cliente no fluxo atual).
    return {
      texto: "Recebi todos os dados. Um especialista vai preparar sua cotação e retornar em breve. 🙌",
      cotacaoId,
      maisBarata: null,
    };
  },
};
