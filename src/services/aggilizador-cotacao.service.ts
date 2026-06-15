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
import { obterCredenciaisSegfy, lerComissaoPadrao } from "./segfy-credenciais.service";
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
    // Dados do SEGURADO (cpf/nascimento/sexo) → etapa "segurado"; placa/cep → "veiculo".
    const ehSegurado = faltando.some((f) => /cpf|nascimento|sexo|segurado/i.test(f));
    return falhar(
      ehSegurado ? "segurado" : "veiculo",
      `Cotação não disparada — faltam: ${faltando.join(", ")}. Complete em 'Dados coletados' (ou peça à Bia) e cote de novo.`,
    );
  }

  // Login do Aggilizador da corretora (mesma linha do Segfy no banco; o `password`
  // guardado é a senha do Aggilizador quando sistema='aggilizador').
  const credenciais = await obterCredenciaisSegfy(params.corretoraId);
  if (!credenciais) {
    return falhar("token", "Credenciais do Aggilizador não configuradas (Admin > Configuração da corretora).");
  }

  // Comissão "coringa" da corretora (default no Setup); a da cotação (manual) tem
  // precedência e é resolvida dentro de cotarAutoAggilizador via entrada.
  const comissaoPadrao = await lerComissaoPadrao(params.corretoraId);

  // Etapas de ERRO são aguardadas antes de retornar null — assim quem chama
  // (bot.service) consegue LER a etapa de falha (ex.: veículo não encontrado) sem
  // corrida. Etapas de progresso seguem fire-and-forget (não bloqueiam o fluxo).
  const etapasErro: Promise<unknown>[] = [];

  try {
    const { idIntegracao, resultados } = await cotarAutoAggilizador(
      entrada,
      { email: credenciais.email, senha: credenciais.password },
      (e) => {
        const pr = persist.registrarEtapa({
          cotacaoId,
          conversaId: params.conversaId,
          etapa: e.etapa,
          status: e.status,
          mensagem: e.mensagem,
        });
        if (e.status === "erro") etapasErro.push(Promise.resolve(pr).catch(() => undefined));
        else void pr;
      },
      comissaoPadrao,
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
    // Garante que a etapa de erro esteja PERSISTIDA antes de retornar (quem chama
    // lê a etapa para classificar a falha, ex.: veículo não encontrado).
    await Promise.allSettled(etapasErro);
    logger.error("[aggilizador] cotação falhou (não-fatal)", {
      conversaId: params.conversaId,
      erro: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
