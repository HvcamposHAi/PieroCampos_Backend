/**
 * Orquestrador do agente Bia.
 *
 * Chamado pelo eventHandlers.messages.upsert APÓS a mensagem do cliente já ter
 * sido persistida em `mensagens`. Fluxo:
 *
 *   1. Resolve conversa (estado, categoria, dados_coletados).
 *   2. Se estado != bot_ativo → não responde (humano assumiu, encerrado, etc.).
 *   3. Detecta gatilho de handoff → envia MENSAGEM_HANDOFF, executa UPDATE, sai.
 *      A trigger no banco insere notificações para operadores.
 *   4. RAG → contexto + classifica categoria se ainda duvida/outro.
 *   5. Monta system prompt (BASE cacheado + DINAMICO com contexto).
 *   6. Lê histórico recente da conversa (~10 últimas mensagens).
 *   7. Chama Claude.
 *   8. Persiste resposta da Bia em `mensagens` (origem='bot').
 *   9. Merge dos campos extraídos em conversas.dados_coletados.
 *  10. Envia via sessionManager.enviarTextoBot (sock.sendMessage).
 *
 * Erros não propagam para o handler — logam e mandam mensagem de fallback ao
 * cliente para não deixar conversa sem resposta.
 */
import { getEnv } from "../config/env";
import { chamarBia, type MensagemTurno } from "../integrations/claude/claude.client";
import { getSupabaseAdmin } from "../integrations/whatsapp/supabase";
import type { CategoriaConversa } from "../lib/roteiros";
import { calcularProgresso, getRoteiro } from "../lib/roteiros";
import { buildSystemPromptDinamico, SYSTEM_PROMPT_BASE } from "../lib/system-prompt";
import { logger } from "../utils/logger";
import {
  detectarGatilhoHandoff,
  executarHandoff,
  MENSAGEM_HANDOFF,
} from "./handoff.service";
import { buscarContextoRAG, montarContextoRAG } from "./rag.service";

const FALLBACK_ERRO =
  "Desculpe, tive um problema técnico aqui agora. Já estou chamando um corretor para te atender. 🙏";

/**
 * Acuse enviado quando o cliente escreve DEPOIS que a coleta terminou e a
 * conversa está com a equipe (estados de "equipe trabalhando"). Texto fixo
 * (não vai a Claude). A igualdade exata deste texto com a última saída é o que
 * faz o anti-spam: enviamos só 1× por rajada de mensagens do cliente.
 */
export const AVISO_POS_COLETA =
  "Recebi sua mensagem! 🙌 Já estou com a equipe preparando sua cotação e te retorno por aqui assim que estiver pronta.";

/**
 * Estados em que a equipe está conduzindo a cotação/proposta. Nesses casos o
 * bot não responde de verdade, mas ACUSA recebimento (1×) para não deixar o
 * cliente no vácuo. Demais estados não-bot_ativo (humano_assumiu, bloqueado_vip,
 * apolice_emitida, encerrado) permanecem em silêncio total.
 */
export const ESTADOS_EQUIPE_TRABALHANDO: ReadonlySet<string> = new Set([
  "aguardando_cotacao",
  "cotacao_enviada",
  "aceite_registrado",
  "proposta_transmitida",
]);

const HISTORICO_MAX = 12; // últimas N mensagens (alterna user/assistant)

interface ConversaAtiva {
  id: string;
  cliente_id: string;
  estado: string;
  categoria: CategoriaConversa | null;
  dados_coletados: Record<string, unknown>;
}

async function carregarConversa(conversaId: string): Promise<ConversaAtiva | null> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("conversas")
    .select("id, cliente_id, estado, categoria, dados_coletados")
    .eq("id", conversaId)
    .maybeSingle();
  if (error) {
    logger.error("[bot] falha ao carregar conversa", { conversaId, erro: error.message });
    return null;
  }
  if (!data) return null;
  return {
    id: data.id,
    cliente_id: data.cliente_id,
    estado: data.estado,
    categoria: (data.categoria as CategoriaConversa | null) ?? null,
    dados_coletados:
      (data.dados_coletados as Record<string, unknown> | null) ?? {},
  };
}

async function carregarHistorico(conversaId: string): Promise<MensagemTurno[]> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("mensagens")
    .select("origem, direcao, corpo, enviada_em")
    .eq("conversa_id", conversaId)
    .order("enviada_em", { ascending: false })
    .limit(HISTORICO_MAX);
  if (error) {
    logger.warn("[bot] historico nao carregado", { conversaId, erro: error.message });
    return [];
  }
  const linhas = (data ?? []).reverse() as Array<{
    origem: string;
    direcao: string;
    corpo: string | null;
  }>;
  const turnos: MensagemTurno[] = [];
  for (const m of linhas) {
    if (!m.corpo) continue;
    if (m.origem === "cliente") {
      turnos.push({ role: "user", content: m.corpo });
    } else if (m.origem === "bot" || m.origem === "operador") {
      turnos.push({ role: "assistant", content: m.corpo });
    }
  }
  // Anthropic exige histórico alternado começando com user. Se ficar invertido,
  // colapsa turnos consecutivos do mesmo papel concatenando.
  const compactado: MensagemTurno[] = [];
  for (const t of turnos) {
    const ultimo = compactado[compactado.length - 1];
    if (ultimo && ultimo.role === t.role) {
      ultimo.content += "\n" + t.content;
    } else {
      compactado.push(t);
    }
  }
  // Garante que comece com user.
  while (compactado.length > 0 && compactado[0]!.role !== "user") {
    compactado.shift();
  }
  return compactado;
}

/** Corpo da última mensagem de saída (bot ou operador) da conversa, ou null. */
async function carregarUltimaSaida(conversaId: string): Promise<string | null> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("mensagens")
    .select("corpo")
    .eq("conversa_id", conversaId)
    .in("origem", ["bot", "operador"])
    .order("enviada_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.warn("[bot] ultima saida nao carregada", { conversaId, erro: error.message });
    return null;
  }
  return ((data as { corpo: string | null } | null)?.corpo) ?? null;
}

/** Decisão para conversas que NÃO estão em bot_ativo. Função pura (testável). */
export type AcaoForaDoBot =
  | { tipo: "responder" } // bot_ativo → fluxo normal
  | { tipo: "handoff"; gatilho?: string } // cliente pediu humano enquanto a equipe trabalha
  | { tipo: "acusar" } // enviar AVISO_POS_COLETA (1ª mensagem da rajada)
  | { tipo: "suprimir" } // anti-spam: já acusamos esta rajada
  | { tipo: "silencio" }; // humano assumiu / VIP / fluxo encerrado

export function decidirAcaoForaDoBot(params: {
  estado: string;
  textoCliente: string;
  /** Corpo da última saída; só relevante p/ estados de equipe trabalhando. */
  ultimaSaida: string | null;
}): AcaoForaDoBot {
  if (params.estado === "bot_ativo") return { tipo: "responder" };
  if (!ESTADOS_EQUIPE_TRABALHANDO.has(params.estado)) return { tipo: "silencio" };
  const gatilho = detectarGatilhoHandoff(params.textoCliente);
  if (gatilho.detectado) return { tipo: "handoff", gatilho: gatilho.gatilho };
  if ((params.ultimaSaida ?? "").trim() === AVISO_POS_COLETA.trim()) {
    return { tipo: "suprimir" };
  }
  return { tipo: "acusar" };
}

async function mergeDadosColetados(
  conversaId: string,
  atuais: Record<string, unknown>,
  novos: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (Object.keys(novos).length === 0) return atuais;
  const merged = { ...atuais, ...novos };
  const sb = getSupabaseAdmin();
  const { error } = await sb
    .from("conversas")
    .update({ dados_coletados: merged })
    .eq("id", conversaId);
  if (error) {
    logger.warn("[bot] falha ao salvar dados_coletados", {
      conversaId,
      erro: error.message,
    });
    return atuais;
  }
  return merged;
}

export interface ProcessarMensagemInput {
  canalId: string;
  conversaId: string;
  jidRemoto: string;
  textoCliente: string;
  /** Função que efetivamente envia via Baileys e persiste a saída. */
  enviar: (texto: string) => Promise<void>;
}

export async function processarMensagem(input: ProcessarMensagemInput): Promise<void> {
  const env = getEnv();
  if (!env.BIA_ENABLED) {
    logger.info("[bot] BIA_ENABLED=false; ignorando mensagem", {
      conversaId: input.conversaId,
    });
    return;
  }

  let conversa: ConversaAtiva | null;
  try {
    conversa = await carregarConversa(input.conversaId);
  } catch (e) {
    logger.error("[bot] erro carregando conversa", {
      conversaId: input.conversaId,
      erro: (e as Error).message,
    });
    return;
  }
  if (!conversa) return;

  // 1) Estado: bot só responde de fato em bot_ativo. Fora disso, "acusa e
  //    segura" nos estados de equipe trabalhando (1× por rajada, anti-spam) ou
  //    fica em silêncio total (humano assumiu / VIP / fluxo fechado).
  if (conversa.estado !== "bot_ativo") {
    const ultimaSaida = ESTADOS_EQUIPE_TRABALHANDO.has(conversa.estado)
      ? await carregarUltimaSaida(conversa.id)
      : null;
    const acao = decidirAcaoForaDoBot({
      estado: conversa.estado,
      textoCliente: input.textoCliente,
      ultimaSaida,
    });
    switch (acao.tipo) {
      case "handoff":
        try {
          await input.enviar(MENSAGEM_HANDOFF);
          await executarHandoff({
            conversaId: conversa.id,
            motivo: `gatilho_espera:${acao.gatilho ?? "?"}`,
          });
        } catch (e) {
          logger.error("[bot] falha no handoff (estado de espera)", {
            conversaId: conversa.id,
            erro: (e as Error).message,
          });
        }
        return;
      case "acusar":
        try {
          await input.enviar(AVISO_POS_COLETA);
          logger.info("[bot] acuse pos-coleta enviado", {
            conversaId: conversa.id,
            estado: conversa.estado,
          });
        } catch (e) {
          logger.error("[bot] falha ao enviar acuse pos-coleta", {
            conversaId: conversa.id,
            erro: (e as Error).message,
          });
        }
        return;
      case "suprimir":
        logger.info("[bot] acuse pos-coleta suprimido (anti-spam)", {
          conversaId: conversa.id,
          estado: conversa.estado,
        });
        return;
      default:
        logger.info("[bot] conversa nao esta em bot_ativo, nao respondendo", {
          conversaId: conversa.id,
          estado: conversa.estado,
        });
        return;
    }
  }

  // 2) Handoff: detectar gatilho ANTES de chamar Claude (econômico).
  const gatilho = detectarGatilhoHandoff(input.textoCliente);
  if (gatilho.detectado) {
    try {
      await input.enviar(MENSAGEM_HANDOFF);
      await executarHandoff({
        conversaId: conversa.id,
        motivo: `gatilho:${gatilho.gatilho}`,
      });
    } catch (e) {
      logger.error("[bot] falha no handoff", {
        conversaId: conversa.id,
        erro: (e as Error).message,
      });
    }
    return;
  }

  // 3) RAG + monta prompt.
  let contextoTexto = "";
  try {
    const ctx = await buscarContextoRAG({
      clienteId: conversa.cliente_id,
      conversaAtualId: conversa.id,
    });
    contextoTexto = montarContextoRAG(ctx);

    // VIP: handoff imediato sem chamar Claude.
    if (ctx.cliente?.atendimento_vip) {
      await input.enviar(
        "Olá! Aqui é a Bia 😊 Vou te direcionar direto para seu atendente. Já avisei a equipe!",
      );
      await executarHandoff({ conversaId: conversa.id, motivo: "cliente_vip" });
      return;
    }
  } catch (e) {
    logger.warn("[bot] RAG falhou; seguindo sem contexto", {
      conversaId: conversa.id,
      erro: (e as Error).message,
    });
  }

  const progresso = calcularProgresso(conversa.categoria, conversa.dados_coletados);
  const proximoCampo = progresso.pendentesObrigatorios[0] ?? null;

  const systemDinamico = buildSystemPromptDinamico({
    categoria: conversa.categoria,
    contextoRAG: contextoTexto,
    dadosColetados: conversa.dados_coletados,
    pendentesObrigatorios: progresso.pendentesObrigatorios,
    proximoCampo,
  });

  // 4) Histórico (já inclui a mensagem que acabou de chegar, pois persistimos antes).
  const historico = await carregarHistorico(conversa.id);

  // 5) Chama Claude.
  let resposta;
  try {
    resposta = await chamarBia({
      systemBase: SYSTEM_PROMPT_BASE,
      systemDinamico,
      historico,
    });
  } catch (e) {
    logger.error("[bot] Claude falhou", {
      conversaId: conversa.id,
      erro: (e as Error).message,
    });
    try {
      await input.enviar(FALLBACK_ERRO);
      await executarHandoff({ conversaId: conversa.id, motivo: "erro_claude" });
    } catch (e2) {
      logger.error("[bot] fallback enviar/handoff tambem falhou", {
        conversaId: conversa.id,
        erro: (e2 as Error).message,
      });
    }
    return;
  }

  // 6) Persistir campos extraídos.
  if (Object.keys(resposta.camposExtraidos).length > 0) {
    await mergeDadosColetados(
      conversa.id,
      conversa.dados_coletados,
      resposta.camposExtraidos,
    );
  }

  // 7) Detectar "ROTEIRO COMPLETO" e mudar estado para aguardando_cotacao.
  if (conversa.categoria && getRoteiro(conversa.categoria)) {
    const progressoAtualizado = calcularProgresso(conversa.categoria, {
      ...conversa.dados_coletados,
      ...resposta.camposExtraidos,
    });
    if (progressoAtualizado.completo) {
      const sb = getSupabaseAdmin();
      await sb
        .from("conversas")
        .update({ estado: "aguardando_cotacao" })
        .eq("id", conversa.id);
      logger.info("[bot] roteiro completo, estado=aguardando_cotacao", {
        conversaId: conversa.id,
      });
    }
  }

  // 8) Enviar a resposta da Bia ao cliente.
  if (!resposta.texto || resposta.texto.trim() === "") {
    logger.warn("[bot] Claude retornou texto vazio; nao envio nada", {
      conversaId: conversa.id,
    });
    return;
  }
  try {
    await input.enviar(resposta.texto);
  } catch (e) {
    logger.error("[bot] falha ao enviar resposta via Baileys", {
      conversaId: conversa.id,
      erro: (e as Error).message,
    });
  }
}

// Exporta também a função para os testes mockarem persistência.
export const _internals = {
  carregarConversa,
  carregarHistorico,
  carregarUltimaSaida,
  mergeDadosColetados,
};
