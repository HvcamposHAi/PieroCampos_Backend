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
import { gerarQuestionarioXlsx, parseQuestionarioXlsx } from "../integrations/formulario";
import { getSupabaseAdmin } from "../integrations/whatsapp/supabase";
import type { CategoriaConversa } from "../lib/roteiros";
import { calcularProgresso, getRoteiro } from "../lib/roteiros";
import { buildSystemPromptDinamico, SYSTEM_PROMPT_BASE, type ModoBia } from "../lib/system-prompt";
import { logger } from "../utils/logger";
import {
  detectarGatilhoHandoff,
  executarHandoff,
  MENSAGEM_HANDOFF,
} from "./handoff.service";
import { buscarContextoRAG, montarContextoRAG } from "./rag.service";
import { dispararCotacaoSegfy } from "./segfy-cotacao.service";

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

const MIME_XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CAPTION_FORMULARIO =
  "Preencha a coluna *Resposta* e me devolva este arquivo aqui mesmo 🙂";

interface ConversaAtiva {
  id: string;
  cliente_id: string;
  estado: string;
  categoria: CategoriaConversa | null;
  dados_coletados: Record<string, unknown>;
  /** Estado interno do bot (modalidade, formulário). Pode estar ausente em prod
   *  antes do ALTER TABLE — tratamos null como {} (degrada com segurança). */
  dados_bot: Record<string, unknown>;
}

async function carregarConversa(conversaId: string): Promise<ConversaAtiva | null> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("conversas")
    .select("id, cliente_id, estado, categoria, dados_coletados, dados_bot")
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
    // Guard de objeto: em prod sem a migration de default, dados_coletados pode
    // vir como '[]'::jsonb (array). Spread de array quebra o merge — normaliza p/ {}.
    dados_coletados: comoObjeto(data.dados_coletados),
    dados_bot: comoObjeto(
      (data as { dados_bot?: Record<string, unknown> | null }).dados_bot,
    ),
  };
}

/** Normaliza um valor jsonb em objeto plano; array/null/escalar → {}. */
function comoObjeto(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
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

/**
 * Postura da Bia conforme o estado da conversa. Função pura (testável).
 *  - ativo          → bot_ativo: coleta normal + conversa aberta.
 *  - espera_equipe  → estados de equipe trabalhando: acuse fixo + anti-spam.
 *  - holding_humano → humano/apólice: Bia só acolhe (NUNCA fica calada), sem coletar.
 *  - mudo           → bloqueado_vip/encerrado: não responde.
 */
export function decidirModoBia(estado: string): ModoBia {
  if (estado === "bot_ativo") return "ativo";
  // Coleta concluída: a Bia fica ATIVA para pedir a decisão de cotar ao cliente.
  if (estado === "aguardando_confirmacao_cotacao") return "ativo";
  if (ESTADOS_EQUIPE_TRABALHANDO.has(estado)) return "espera_equipe";
  if (estado === "humano_assumiu" || estado === "apolice_emitida") return "holding_humano";
  return "mudo"; // bloqueado_vip, encerrado
}

/**
 * A Bia deve oferecer a escolha "1 a 1 ou formulário" neste turno? Só para os
 * roteiros longos (renovacao/seguro_novo), antes de qualquer coleta e enquanto
 * a modalidade ainda não foi escolhida. Função pura (testável).
 */
export function deveOferecerModalidade(p: {
  categoria: CategoriaConversa | null;
  dadosBot: Record<string, unknown>;
  dadosColetados: Record<string, unknown>;
}): boolean {
  if (p.categoria !== "renovacao" && p.categoria !== "seguro_novo") return false;
  if ((p.dadosBot as { modalidade?: unknown })?.modalidade) return false;
  return Object.keys(p.dadosColetados).length === 0;
}

/** Lê a fila campos_forcados de dados_bot como lista de strings (defensivo). */
function lerFilaForcada(dadosBot: Record<string, unknown>): string[] {
  const raw = (dadosBot as { campos_forcados?: unknown }).campos_forcados;
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : [];
}

/**
 * Escolhe o PRIMEIRO campo forçado pelo operador que ainda está pendente e
 * pertence ao roteiro da categoria. Retorna null se a fila estiver vazia ou
 * todos os pedidos já estiverem preenchidos. Função pura (testável).
 */
export function escolherCampoForcado(
  dadosBot: Record<string, unknown>,
  dadosColetados: Record<string, unknown>,
  categoria: CategoriaConversa | null,
): import("../lib/roteiros").CampoRoteiro | null {
  const fila = lerFilaForcada(dadosBot);
  if (fila.length === 0) return null;
  const roteiro = getRoteiro(categoria);
  if (!roteiro) return null;
  for (const chave of fila) {
    const v = dadosColetados[chave];
    if (v != null && v !== "") continue; // já preenchido → ignora
    const campo = roteiro.campos.find((c) => c.chave === chave);
    if (campo) return campo;
  }
  return null;
}

/** Remove da fila campos_forcados as chaves já preenchidas. No-op se nada mudou. */
async function sincronizarFilaForcada(
  conversaId: string,
  dadosBot: Record<string, unknown>,
  dados: Record<string, unknown>,
): Promise<void> {
  const fila = lerFilaForcada(dadosBot);
  if (fila.length === 0) return;
  const restante = fila.filter((ch) => !(dados[ch] != null && dados[ch] !== ""));
  if (restante.length === fila.length) return; // nada preenchido nesta rodada
  await mergeDadosBot(conversaId, dadosBot, { campos_forcados: restante });
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

/** Merge raso em `conversas.dados_bot` (modalidade/formulário). */
async function mergeDadosBot(
  conversaId: string,
  atuais: Record<string, unknown>,
  novos: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (Object.keys(novos).length === 0) return atuais;
  const merged = { ...atuais, ...novos };
  const sb = getSupabaseAdmin();
  const { error } = await sb
    .from("conversas")
    .update({ dados_bot: merged })
    .eq("id", conversaId);
  if (error) {
    logger.warn("[bot] falha ao salvar dados_bot", { conversaId, erro: error.message });
    return atuais;
  }
  return merged;
}

/** Grava o consentimento LGPD do cliente (autorização dada no chat). */
async function registrarConsentimentoLgpd(clienteId: string): Promise<void> {
  const sb = getSupabaseAdmin();
  const { error } = await sb
    .from("clientes")
    .update({ consentimento_lgpd: true, consentimento_em: new Date().toISOString() })
    .eq("id", clienteId);
  if (error) {
    logger.warn("[bot] falha ao registrar consentimento LGPD", { clienteId, erro: error.message });
  } else {
    logger.info("[bot] consentimento LGPD registrado", { clienteId });
  }
}

/**
 * Se o roteiro estiver completo: NÃO dispara cotação automaticamente — muda o
 * estado p/ `aguardando_confirmacao_cotacao`, onde a Bia pede a DECISÃO do
 * cliente ("posso gerar sua cotação agora?"). O disparo real só acontece no
 * `confirmarEdispararCotacao` (cliente confirma OU operador força pelo painel).
 * Compartilhado entre o fluxo de texto e o de formulário.
 */
export async function finalizarSeRoteiroCompleto(p: {
  conversaId: string;
  categoria: CategoriaConversa | null;
  dados: Record<string, unknown>;
}): Promise<{ completo: boolean }> {
  if (!p.categoria || !getRoteiro(p.categoria)) return { completo: false };
  const progresso = calcularProgresso(p.categoria, p.dados);
  if (!progresso.completo) return { completo: false };

  const sb = getSupabaseAdmin();
  await sb
    .from("conversas")
    .update({ estado: "aguardando_confirmacao_cotacao" })
    .eq("id", p.conversaId);
  logger.info("[bot] roteiro completo, estado=aguardando_confirmacao_cotacao", {
    conversaId: p.conversaId,
  });
  return { completo: true };
}

/**
 * Dispara a cotação no Segfy (decisão do cliente OU do operador): muda p/
 * `aguardando_cotacao`, executa o pipeline (registrando etapas) e, havendo
 * resultado, envia o comparativo (menor preço em destaque) e move p/
 * `cotacao_enviada`. Se a flag estiver off ou faltarem dados, fica em
 * `aguardando_cotacao` (a equipe assume). Não-fatal.
 */
export async function confirmarEdispararCotacao(p: {
  conversaId: string;
  clienteId: string;
  dados: Record<string, unknown>;
  enviar: (texto: string) => Promise<void>;
}): Promise<{ cotou: boolean }> {
  const sb = getSupabaseAdmin();
  await sb.from("conversas").update({ estado: "aguardando_cotacao" }).eq("id", p.conversaId);

  const cotacao = await dispararCotacaoSegfy({
    conversaId: p.conversaId,
    clienteId: p.clienteId,
    dados: p.dados,
  });
  if (!cotacao) return { cotou: false };
  try {
    await p.enviar(cotacao.texto);
    await sb.from("conversas").update({ estado: "cotacao_enviada" }).eq("id", p.conversaId);
    logger.info("[bot] cotação Segfy enviada, estado=cotacao_enviada", { conversaId: p.conversaId });
  } catch (e) {
    logger.error("[bot] falha ao enviar comparativo/atualizar estado", {
      conversaId: p.conversaId,
      erro: (e as Error).message,
    });
  }
  return { cotou: true };
}

/**
 * Gera e envia o questionário .xlsx da categoria. Degrada para no-op logado se
 * não houver canal de documento. Marca dados_bot.formulario.enviado_em.
 */
async function enviarFormulario(p: {
  conversaId: string;
  categoria: CategoriaConversa;
  dadosBot: Record<string, unknown>;
  enviarDocumento?: EnviarDocumento;
}): Promise<void> {
  if (!p.enviarDocumento) {
    logger.warn("[bot] enviarFormulario sem canal de documento; no-op", {
      conversaId: p.conversaId,
    });
    return;
  }
  let buf: Buffer;
  try {
    buf = await gerarQuestionarioXlsx(p.categoria);
  } catch (e) {
    logger.error("[bot] falha ao gerar questionário xlsx", {
      conversaId: p.conversaId,
      erro: (e as Error).message,
    });
    return;
  }
  try {
    await p.enviarDocumento({
      documento: buf,
      fileName: `Questionario_${p.categoria}_PieroCampos.xlsx`,
      mimetype: MIME_XLSX,
      caption: CAPTION_FORMULARIO,
    });
  } catch (e) {
    logger.error("[bot] falha ao enviar questionário xlsx", {
      conversaId: p.conversaId,
      erro: (e as Error).message,
    });
    return;
  }
  await mergeDadosBot(p.conversaId, p.dadosBot, {
    formulario: {
      enviado_em: new Date().toISOString(),
      categoria: p.categoria,
      versao: 1,
    },
  });
}

/** Envia um documento já vinculado ao canal/conversa/jid (injetado pelo handler). */
export type EnviarDocumento = (doc: {
  documento: Buffer;
  fileName: string;
  mimetype: string;
  caption?: string;
}) => Promise<void>;

export interface ProcessarMensagemInput {
  canalId: string;
  conversaId: string;
  jidRemoto: string;
  textoCliente: string;
  /** Função que efetivamente envia via Baileys e persiste a saída. */
  enviar: (texto: string) => Promise<void>;
  /** Envio de documento (opcional; ausente em rotas/testes só-texto). */
  enviarDocumento?: EnviarDocumento;
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

  // 1) Postura do turno conforme o estado.
  //    - mudo          → não responde (bloqueado_vip / encerrado).
  //    - espera_equipe → acuse fixo + anti-spam (comportamento original).
  //    - ativo/holding → segue para o Claude (coleta normal ou acolhimento).
  const modo = decidirModoBia(conversa.estado);

  if (modo === "mudo") {
    logger.info("[bot] modo mudo; nao respondendo", {
      conversaId: conversa.id,
      estado: conversa.estado,
    });
    return;
  }

  if (modo === "espera_equipe") {
    const ultimaSaida = await carregarUltimaSaida(conversa.id);
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
      default: // suprimir (anti-spam)
        logger.info("[bot] acuse pos-coleta suprimido (anti-spam)", {
          conversaId: conversa.id,
          estado: conversa.estado,
        });
        return;
    }
  }

  // 2) Handoff: detectar gatilho ANTES de chamar Claude (econômico). Vale para
  //    modo ativo E holding (ex.: cliente pede cancelamento / fala em sinistro).
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

    // VIP: handoff imediato sem chamar Claude (só no fluxo ativo; em holding o
    // humano já assumiu).
    if (modo === "ativo" && ctx.cliente?.atendimento_vip) {
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
  // Pedido do operador (fila campos_forcados em dados_bot): prioridade máxima.
  const campoForcado = escolherCampoForcado(
    conversa.dados_bot,
    conversa.dados_coletados,
    conversa.categoria,
  );
  // Coleta concluída: a Bia pede a decisão de cotar (e ganha a tool confirmar_cotacao).
  const ehConfirmacao = conversa.estado === "aguardando_confirmacao_cotacao";
  const oferecerModalidade =
    !ehConfirmacao &&
    modo === "ativo" &&
    deveOferecerModalidade({
      categoria: conversa.categoria,
      dadosBot: conversa.dados_bot,
      dadosColetados: conversa.dados_coletados,
    });

  const systemDinamico = buildSystemPromptDinamico({
    categoria: conversa.categoria,
    contextoRAG: contextoTexto,
    dadosColetados: conversa.dados_coletados,
    pendentesObrigatorios: progresso.pendentesObrigatorios,
    proximoCampo,
    campoForcado,
    modo,
    oferecerModalidade,
    pedirConfirmacaoCotacao: ehConfirmacao,
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
      permitirConfirmacao: ehConfirmacao,
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

  // 6) Holding (humano assumiu): só acolhe — não coleta, não muda estado, não
  //    dispara cotação. Envia o texto e encerra o turno.
  if (modo !== "ativo") {
    await enviarRespostaBia(resposta.texto, input.enviar, conversa.id);
    return;
  }

  // 6.1) Consentimento LGPD: se o cliente autorizou neste turno, grava no cadastro
  //      (clientes.consentimento_lgpd) — pré-requisito para a cotação no Segfy.
  if (resposta.consentimentoLgpd === true) {
    await registrarConsentimentoLgpd(conversa.cliente_id);
  }

  // 7) Persistir campos extraídos.
  if (Object.keys(resposta.camposExtraidos).length > 0) {
    await mergeDadosColetados(
      conversa.id,
      conversa.dados_coletados,
      resposta.camposExtraidos,
    );
  }

  // 7.1) Dequeue da fila de campos forçados: remove os que já foram preenchidos
  //      (pelo operador ou agora pelo cliente). Best-effort, não bloqueia a resposta.
  await sincronizarFilaForcada(conversa.id, conversa.dados_bot, {
    ...conversa.dados_coletados,
    ...resposta.camposExtraidos,
  });

  // 8) Enviar a resposta da Bia ao cliente (se houver texto).
  await enviarRespostaBia(resposta.texto, input.enviar, conversa.id);

  // 8.1) Fase de confirmação: o cliente decidiu cotar AGORA?
  if (ehConfirmacao) {
    if (resposta.confirmarCotacao === true) {
      await confirmarEdispararCotacao({
        conversaId: conversa.id,
        clienteId: conversa.cliente_id,
        dados: conversa.dados_coletados,
        enviar: input.enviar,
      });
    }
    // confirmado=false/null → a Bia já respondeu; segue em aguardando_confirmacao.
    return;
  }

  // 9) Modalidade escolhida neste turno: registra e, se "formulário", envia o
  //    questionário .xlsx. O gate fecha o turno (não coleta junto).
  if (resposta.modalidadeEscolhida) {
    const dadosBotAtualizado = await mergeDadosBot(conversa.id, conversa.dados_bot, {
      modalidade: resposta.modalidadeEscolhida,
    });
    if (resposta.modalidadeEscolhida === "formulario" && conversa.categoria) {
      await enviarFormulario({
        conversaId: conversa.id,
        categoria: conversa.categoria,
        dadosBot: dadosBotAtualizado,
        enviarDocumento: input.enviarDocumento,
      });
    }
    return;
  }

  // 10) Roteiro recém-concluído → vai p/ a fase de CONFIRMAÇÃO do cliente
  //     (não dispara cotação automaticamente). Helper compartilhado c/ formulário.
  const dadosMerge = { ...conversa.dados_coletados, ...resposta.camposExtraidos };
  await finalizarSeRoteiroCompleto({
    conversaId: conversa.id,
    categoria: conversa.categoria,
    dados: dadosMerge,
  });
}

/** Envia o texto da Bia se não estiver vazio; loga e não envia se vazio. */
async function enviarRespostaBia(
  texto: string,
  enviar: (t: string) => Promise<void>,
  conversaId: string,
): Promise<void> {
  if (!texto || texto.trim() === "") {
    logger.warn("[bot] Claude retornou texto vazio; nao envio nada", { conversaId });
    return;
  }
  try {
    await enviar(texto);
  } catch (e) {
    logger.error("[bot] falha ao enviar resposta via Baileys", {
      conversaId,
      erro: (e as Error).message,
    });
  }
}

export interface ProcessarFormularioRecebidoInput {
  canalId: string;
  conversaId: string;
  jidRemoto: string;
  /** Buffer do .xlsx baixado do WhatsApp. */
  documento: Buffer;
  enviar: (texto: string) => Promise<void>;
}

/**
 * Processa um questionário .xlsx devolvido pelo cliente: parseia, mescla em
 * dados_coletados e, se o roteiro completar, segue para a cotação. Idempotente
 * por dados_bot.formulario.recebido_em. Só atua com a conversa em bot_ativo.
 */
export async function processarFormularioRecebido(
  input: ProcessarFormularioRecebidoInput,
): Promise<void> {
  const env = getEnv();
  if (!env.BIA_ENABLED) return;

  let conversa: ConversaAtiva | null;
  try {
    conversa = await carregarConversa(input.conversaId);
  } catch (e) {
    logger.error("[bot] erro carregando conversa (formulário)", {
      conversaId: input.conversaId,
      erro: (e as Error).message,
    });
    return;
  }
  if (!conversa) return;

  // Conversa fora de bot_ativo: só acusa; um humano analisa o arquivo.
  if (conversa.estado !== "bot_ativo") {
    try {
      await input.enviar(
        "Recebi seu formulário! ✅ Um corretor vai analisar e te dá retorno por aqui.",
      );
    } catch {
      /* não-fatal */
    }
    return;
  }

  // Idempotência: já processamos um formulário nesta conversa?
  const formMeta = (conversa.dados_bot.formulario ?? {}) as { recebido_em?: string };
  if (formMeta.recebido_em) {
    logger.info("[bot] formulário já processado; ignorando", { conversaId: conversa.id });
    return;
  }

  const parsed = await parseQuestionarioXlsx(input.documento);
  if (!parsed) {
    try {
      await input.enviar(
        "Recebi um arquivo, mas não consegui ler como o formulário que enviei. Pode reenviar a planilha preenchida, ou me responder por aqui mesmo? 🙂",
      );
    } catch {
      /* não-fatal */
    }
    return;
  }

  // Drift guard: mescla só chaves do roteiro da conversa.
  const roteiro = getRoteiro(conversa.categoria);
  const validasDoRoteiro = new Set((roteiro?.campos ?? []).map((c) => c.chave));
  const novos: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.respostas)) {
    if (validasDoRoteiro.has(k)) novos[k] = v;
  }
  if (parsed.categoria !== conversa.categoria) {
    logger.warn("[bot] categoria do formulário difere da conversa", {
      conversaId: conversa.id,
      arquivo: parsed.categoria,
      conversa: conversa.categoria,
    });
  }

  const dadosMerge = await mergeDadosColetados(conversa.id, conversa.dados_coletados, novos);
  await mergeDadosBot(conversa.id, conversa.dados_bot, {
    formulario: {
      ...(conversa.dados_bot.formulario as Record<string, unknown> | undefined),
      recebido_em: new Date().toISOString(),
    },
  });

  try {
    await input.enviar("Recebi sua planilha! ✅ Já estou conferindo os dados.");
  } catch {
    /* não-fatal */
  }

  const { completo } = await finalizarSeRoteiroCompleto({
    conversaId: conversa.id,
    categoria: conversa.categoria,
    dados: dadosMerge,
  });

  if (!completo) {
    try {
      await input.enviar(
        "Faltou preencher alguns campos obrigatórios. Posso te perguntar o restante por aqui mesmo? 🙂",
      );
    } catch {
      /* não-fatal */
    }
  }
}

// Exporta também a função para os testes mockarem persistência.
export const _internals = {
  carregarConversa,
  carregarHistorico,
  carregarUltimaSaida,
  mergeDadosColetados,
};
