/**
 * Ponte bot/operador → Aggilizador (multicálculo Auto). Mesma assinatura e
 * contrato de `dispararCotacaoSegfy` — o provider (`aggilizador-auto.provider`) e
 * o orquestrador (`cotacao.service`) tratam os dois sistemas de forma idêntica.
 *
 * Observabilidade PRIMEIRO: cria a cotação (`processando`) e registra cada etapa,
 * inclusive nos caminhos de erro (flag off, sem consentimento/dados, credencial
 * faltando, falha do Aggilizador) — cada caso vira uma etapa de ERRO legível.
 *
 * Diferenças vs Segfy: (a) sem pré-check de sessão/2FA (Aggilizador é stateless,
 * sem 2FA); (b) credenciais = login do Aggilizador da corretora (mesma linha
 * `segfy_credenciais`, reaproveitada via `obterCredenciaisSegfy`); (c) seguradoras
 * e suas credenciais vêm do próprio Aggilizador (/cfg/seguradora/config), não da
 * curadoria local. Falha do Aggilizador NUNCA quebra o bot: loga e retorna null.
 */
import { getEnv } from "../config/env";
import { cotarAutoAggilizador } from "../integrations/aggilizador/aggilizador.multicalculo";
import { mapearParaCotacaoAggilizador } from "../integrations/aggilizador/aggilizador.mapper";
import { formatarComparativoParaWhatsApp } from "../integrations/segfy/segfy.format";
import type { ResultadoCotacaoItem } from "../integrations/segfy/segfy.types";
import type { PersistencePort } from "../integrations/segfy/persistence.port";
import { SupabasePersistence } from "../integrations/persistence/supabase-persistence";
import { obterCredenciaisSegfy } from "./segfy-credenciais.service";
import { asString } from "../integrations/quote/mapper/legacy";
import { logger } from "../utils/logger";

const VALIDADE_COTACAO_MS = 7 * 24 * 60 * 60 * 1000;

export interface ResultadoDisparoAggilizador {
  texto: string;
  cotacaoId: string | null;
  maisBarata: ResultadoCotacaoItem | null;
}

export async function dispararCotacaoAggilizador(
  params: {
    conversaId: string | null;
    clienteId: string;
    dados: Record<string, unknown>;
    origem?: "whatsapp" | "manual";
    corretoraId?: string;
  },
  persistInjetado?: PersistencePort,
  onIniciada?: (cotacaoId: string) => void,
): Promise<ResultadoDisparoAggilizador | null> {
  const env = getEnv();
  const persist: PersistencePort =
    persistInjetado ?? new SupabasePersistence(undefined, params.corretoraId);

  const { cotacaoId } = await persist.iniciarCotacao({
    conversaId: params.conversaId,
    clienteId: params.clienteId,
    ramo: "auto",
    dadosEntrada: params.dados,
    origem: params.origem,
  });
  onIniciada?.(cotacaoId);

  const falhar = async (
    etapa: "token" | "segurado" | "veiculo" | "calculo" | "coleta" | "salvar",
    msg: string,
  ): Promise<null> => {
    await persist.registrarEtapa({ cotacaoId, conversaId: params.conversaId, etapa, status: "erro", mensagem: msg });
    await persist.atualizarCotacao(cotacaoId, { status: "erro" });
    logger.warn("[aggilizador] cotação não concluída", { conversaId: params.conversaId, etapa, msg });
    return null;
  };

  if (!env.AGGILIZADOR_ENABLED) {
    return falhar("token", "Integração Aggilizador desabilitada (AGGILIZADOR_ENABLED=false). Habilite para cotar.");
  }
  const cliente = await persist.buscarClientePorId(params.clienteId, params.corretoraId);
  if (!cliente) return falhar("token", "Cliente não encontrado ou excluído.");
  if (!cliente.consentimento_lgpd) return falhar("token", "Sem consentimento LGPD do cliente.");

  const { entrada, faltando } = mapearParaCotacaoAggilizador(params.dados, cliente);
  if (!entrada) {
    const etapaFalha = faltando.some((f) => f.startsWith("cpf")) ? "segurado" : "veiculo";
    return falhar(etapaFalha, `Faltam dados para cotar: ${faltando.join(", ")}. Complemente em 'Dados coletados'.`);
  }

  // Login do Aggilizador da corretora (mesma linha do Segfy no banco; o `password`
  // guardado é a senha do Aggilizador quando sistema='aggilizador').
  const credenciais = await obterCredenciaisSegfy(params.corretoraId);
  if (!credenciais) {
    return falhar("token", "Credenciais do Aggilizador não configuradas (Admin > Configuração da corretora).");
  }

  try {
    const { idIntegracao, resultados } = await cotarAutoAggilizador(
      entrada,
      { email: credenciais.email, senha: credenciais.password },
      (e) => {
        void persist.registrarEtapa({
          cotacaoId,
          conversaId: params.conversaId,
          etapa: e.etapa,
          status: e.status,
          mensagem: e.mensagem,
        });
      },
    );

    await persist.atualizarCotacao(cotacaoId, {
      status: "concluida",
      resultados,
      segfyCotacaoId: idIntegracao ?? undefined,
      validadeAte: new Date(Date.now() + VALIDADE_COTACAO_MS).toISOString(),
    });
    await persist.registrarEtapa({ cotacaoId, conversaId: params.conversaId, etapa: "salvar", status: "ok", mensagem: "Cotação salva." });
    await persist.registrarLog({
      operacao: "cotacao",
      via: "api",
      refId: idIntegracao ?? undefined,
      sucesso: resultados.some((r) => r.status === "cotado"),
      detalhe: {
        provider: "aggilizador-auto",
        total: resultados.length,
        cotadas: resultados.filter((r) => r.status === "cotado").length,
      },
    });

    const maisBarata = resultados.find((r) => r.status === "cotado") ?? null;
    const nome = asString(params.dados.nome) ?? cliente.nome ?? "tudo certo";
    return { texto: formatarComparativoParaWhatsApp(resultados, nome), cotacaoId, maisBarata };
  } catch (e) {
    // A etapa real que falhou já foi registrada pelo onEtapa do cotarAuto. Só
    // marcamos a cotação como erro (não criamos uma 2ª linha vermelha em "salvar").
    await persist.atualizarCotacao(cotacaoId, { status: "erro" });
    logger.error("[aggilizador] cotação falhou (não-fatal)", {
      conversaId: params.conversaId,
      erro: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
