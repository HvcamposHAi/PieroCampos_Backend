/**
 * Ponte bot → Segfy (multicálculo Auto). Mapeia os `dados_coletados` da conversa
 * (roteiro da Bia) para a entrada da API do Segfy e dispara via `cotarAuto`
 * (HTTP, sem browser) e persiste.
 *
 * O MAPEAMENTO de dados→entrada vive em `integrations/quote/mapper`:
 *   - `legacy.mapearParaCotacao` (re-exportado aqui) = comportamento hardcoded
 *     atual; é o FALLBACK FAIL-CLOSED.
 *   - `resolverEntrada` decide dinâmico × hardcoded (flag + toggle por corretora)
 *     e cai no fallback em qualquer falha. Quando o mapeamento dinâmico está off,
 *     a saída é byte-idêntica ao hardcoded de hoje.
 *
 * Regras:
 *   - Só dispara com SEGFY_ENABLED=true e consentimento_lgpd (guarda no bot).
 *   - Sem CPF (do cliente) ou sem placa (do veículo) → não cota (faltando[]).
 *   - Falha do Segfy nunca quebra o bot: loga e retorna null.
 */
import { getEnv } from "../config/env";
import { cotarAuto } from "../integrations/segfy/segfy.multicalculo";
import { formatarComparativoParaWhatsApp } from "../integrations/segfy/segfy.format";
import type { ResultadoCotacaoItem } from "../integrations/segfy/segfy.types";
import type { PersistencePort } from "../integrations/segfy/persistence.port";
import { SupabasePersistence } from "../integrations/persistence/supabase-persistence";
import { obterCredenciaisSegfy } from "./segfy-credenciais.service";
import { restaurarSessao, marcarSessaoExpirada } from "./segfy-sessao.service";
import { notificarReauthNecessaria } from "./segfy-alertas.service";
import { listarSeguradorasAtivas } from "./segfy-seguradoras.service";
import { SegfyReauthNecessariaError } from "../integrations/segfy/errors";
import { asString, mapearParaCotacao, type EntradaMapeada } from "../integrations/quote/mapper/legacy";
import { resolverEntrada } from "../integrations/quote/mapper/dynamic-mapper.service";
import { logger } from "../utils/logger";

// Re-exporta o contrato público do mapeamento (imports de testes intactos).
export { mapearParaCotacao, type EntradaMapeada };

const VALIDADE_COTACAO_MS = 7 * 24 * 60 * 60 * 1000;

export interface ResultadoDisparo {
  texto: string;
  cotacaoId: string | null;
  /** Seguradora de MENOR PREÇO (resultado destaque ao cliente), ou null. */
  maisBarata: ResultadoCotacaoItem | null;
}

/**
 * Dispara a cotação no Segfy com OBSERVABILIDADE PRIMEIRO: cria a cotação
 * (`processando`) e a 1ª etapa LOGO no início, para que a tela (aba Etapas +
 * página Cotações) SEMPRE mostre a tentativa — inclusive quando a integração
 * está desabilitada, falta consentimento/dados, ou o Segfy falha (cada caso
 * vira uma etapa de ERRO legível). Devolve o comparativo (menor preço) ou null.
 * `persistInjetado` permite testar sem Supabase.
 */
export async function dispararCotacaoSegfy(
  params: {
    /** Nulo na COTAÇÃO MANUAL (operador digita os dados; não há conversa WhatsApp). */
    conversaId: string | null;
    clienteId: string;
    dados: Record<string, unknown>;
    /** Origem da cotação (default 'whatsapp'); 'manual' para o disparo pelo operador. */
    origem?: "whatsapp" | "manual";
    /** Corretora (tenant) dona da cotação. Omitido → corretora seed (Piero). */
    corretoraId?: string;
  },
  persistInjetado?: PersistencePort,
  /** Chamado LOGO após criar a cotação (id já existe), antes das validações — a
   *  rota manual usa para responder com o cotacaoId e a tela acompanhar ao vivo. */
  onIniciada?: (cotacaoId: string) => void,
): Promise<ResultadoDisparo | null> {
  const env = getEnv();
  // Persistência escopada à corretora: todo insert (cotacoes/etapas/log) carrega
  // o tenant. Quando injetada (testes), respeita a instância recebida.
  const persist: PersistencePort =
    persistInjetado ?? new SupabasePersistence(undefined, params.corretoraId);

  // 1) Cria a cotação SEMPRE (observabilidade imediata via realtime).
  const { cotacaoId } = await persist.iniciarCotacao({
    conversaId: params.conversaId,
    clienteId: params.clienteId,
    ramo: "auto",
    dadosEntrada: params.dados,
    origem: params.origem,
  });
  onIniciada?.(cotacaoId);
  // NÃO pré-marcamos a etapa "token" como andamento aqui: as validações abaixo
  // (flag/cliente/LGPD/dados/credenciais) acontecem ANTES da autenticação. Se
  // alguma falhar, a etapa real de erro é registrada por `falhar(...)` e o passo
  // "token" continua PENDENTE (sem spinner eterno). Quando a corrida real começa,
  // `cotarAuto` emite token→andamento→ok via onEtapa. (Bug: spinner travado na
  // "Autenticação no Segfy" mascarando o erro real de baixo.)

  // Helper: marca a etapa/cotação como ERRO e encerra (visível na tela).
  const falhar = async (etapa: "token" | "segurado" | "veiculo" | "calculo" | "coleta" | "salvar", msg: string): Promise<null> => {
    await persist.registrarEtapa({ cotacaoId, conversaId: params.conversaId, etapa, status: "erro", mensagem: msg });
    await persist.atualizarCotacao(cotacaoId, { status: "erro" });
    logger.warn("[segfy] cotação não concluída", { conversaId: params.conversaId, etapa, msg });
    return null;
  };

  if (!env.SEGFY_ENABLED) {
    return falhar("token", "Integração Segfy desabilitada (SEGFY_ENABLED=false). Habilite para cotar de verdade.");
  }
  const cliente = await persist.buscarClientePorId(params.clienteId, params.corretoraId);
  if (!cliente) return falhar("token", "Cliente não encontrado ou excluído.");
  if (!cliente.consentimento_lgpd) return falhar("token", "Sem consentimento LGPD do cliente.");

  // Mapeamento dinâmico (gated) com fallback FAIL-CLOSED ao hardcoded.
  const { entrada, faltando } = await resolverEntrada(
    params.dados,
    cliente,
    { provider: "segfy", ramo: "auto", corretoraId: params.corretoraId },
    mapearParaCotacao,
  );
  if (!entrada) {
    // CPF falta → falha no passo do segurado; demais (placa/cep) → no veículo.
    const etapaFalha = faltando.some((f) => f.startsWith("cpf")) ? "segurado" : "veiculo";
    return falhar(etapaFalha, `Faltam dados para cotar: ${faltando.join(", ")}. Complemente em 'Dados coletados' ou peça à Bia.`);
  }

  // Credenciais do portal: banco (tela Admin) com fallback .env. Sem nenhuma → não cota.
  const credenciais = await obterCredenciaisSegfy(params.corretoraId);
  if (!credenciais) {
    return falhar("token", "Credenciais do Segfy não configuradas (Admin > Segfy ou .env).");
  }

  // Curadoria: cota SÓ as seguradoras ativas (Admin > Segfy). Vazio → o
  // multicálculo cai no fallback (INSURERS_PADRAO) — nunca deixa de cotar.
  const ativas = await listarSeguradorasAtivas();
  if (ativas.length > 0) entrada.insurers = ativas;

  // Sessão confiável (contorno do 2FA): cookie de device trust + tokens
  // persistidos da última reauth assistida (Admin › Segfy). null → o login HTTP
  // tenta direto e, se cair no 2FA, lança SegfyReauthNecessariaError.
  const sessao = await restaurarSessao();

  try {
    const { quotationId, resultados } = await cotarAuto(
      entrada,
      undefined,
      (e) => {
        void persist.registrarEtapa({
          cotacaoId,
          conversaId: params.conversaId,
          etapa: e.etapa,
          status: e.status,
          mensagem: e.mensagem,
        });
      },
      { email: credenciais.email, password: credenciais.password },
      sessao ?? undefined,
    );

    await persist.atualizarCotacao(cotacaoId, {
      status: "concluida",
      resultados,
      segfyCotacaoId: quotationId ?? undefined,
      validadeAte: new Date(Date.now() + VALIDADE_COTACAO_MS).toISOString(),
    });
    await persist.registrarEtapa({ cotacaoId, conversaId: params.conversaId, etapa: "salvar", status: "ok", mensagem: "Cotação salva." });
    await persist.registrarLog({
      operacao: "cotacao",
      via: "api",
      refId: quotationId ?? undefined,
      sucesso: resultados.some((r) => r.status === "cotado"),
      detalhe: { total: resultados.length, cotadas: resultados.filter((r) => r.status === "cotado").length },
    });

    const maisBarata = resultados.find((r) => r.status === "cotado") ?? null;
    const nome =
      asString(params.dados.nome) ?? asString(params.dados.segurado) ?? cliente.nome ?? "tudo certo";
    return { texto: formatarComparativoParaWhatsApp(resultados, nome), cotacaoId, maisBarata };
  } catch (e) {
    // A etapa REAL que falhou (calculo/segurado/...) já foi registrada como erro
    // pelo `onEtapa` do cotarAuto, com o motivo real. NÃO registramos um segundo
    // erro em "salvar" (isso criava uma 2ª linha vermelha enganosa); só marcamos
    // a cotação como erro — "Salvar cotação" permanece pendente.
    await persist.atualizarCotacao(cotacaoId, { status: "erro" });
    // Falha de SESSÃO (2FA): marca a sessão como expirada para o badge do Admin
    // pedir reautenticação. A etapa "token"/erro já mostrou a mensagem amigável.
    // Avisa o operador (sino + WhatsApp) SÓ na transição (1x por expiração).
    if (e instanceof SegfyReauthNecessariaError) {
      const transicionou = await marcarSessaoExpirada();
      if (transicionou) {
        await notificarReauthNecessaria(
          "A sessão do Segfy expirou — uma cotação não pôde ser concluída. Reautentique em Admin › Segfy.",
        );
      }
    }
    logger.error("[segfy] cotação falhou (não-fatal)", {
      conversaId: params.conversaId,
      erro: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
