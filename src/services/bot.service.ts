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
import { lerBotAtivoCanal } from "../integrations/whatsapp/persistence";
import type { CategoriaConversa } from "../lib/roteiros";
import { calcularProgresso, getRoteiro } from "../lib/roteiros";
import {
  buildBlocoPersonalizacao,
  buildSystemPromptDinamico,
  SYSTEM_PROMPT_BASE,
  type ModoBia,
} from "../lib/system-prompt";
import { obterConfigEfetiva } from "./agente-config.service";
import { logger } from "../utils/logger";
import {
  classificarMotivoHandoff,
  detectarGatilhoHandoff,
  executarHandoff,
  MENSAGEM_HANDOFF,
  type MotivoHandoff,
} from "./handoff.service";
import { buscarContextoRAG, montarContextoRAG } from "./rag.service";
import { obterPlaybookAtivoTexto, lerAprendizadoAtivo } from "./aprendizado.service";
import { mapearParaCotacao } from "./segfy-cotacao.service";
import { dispararCotacao } from "./cotacao.service";
import { SegfyReauthNecessariaError } from "../integrations/segfy/errors";
import { cpfValido, formatarCpf } from "../lib/cpf";
import { normalizarTelefoneBr } from "../lib/telefone";

const FALLBACK_ERRO =
  "Desculpe, tive um problema técnico aqui agora. Já estou chamando um corretor para te atender. 🙏";

/**
 * Estados em que a equipe está conduzindo a cotação/proposta. A Bia NÃO coleta
 * nesses estados, mas RESPONDE (modo holding/acolhimento) — nunca deixa o
 * cliente no vácuo. Usado só para derivar a mensagem de contexto do holding.
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
  /** Linha de WhatsApp da conversa — chave da config de comportamento da Bia. */
  canal_id: string | null;
  estado: string;
  /** Operador dono (setado por "Assumir"). null = handoff automático sem dono ainda. */
  operador_id: string | null;
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
    .select("id, cliente_id, canal_id, estado, operador_id, categoria, dados_coletados, dados_bot")
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
    canal_id: (data as { canal_id?: string | null }).canal_id ?? null,
    estado: data.estado,
    operador_id: (data as { operador_id?: string | null }).operador_id ?? null,
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

/**
 * Postura da Bia conforme o estado. Função pura (testável). A Bia NUNCA fica
 * calada, exceto em `encerrado` (uma nova mensagem reabre como conversa nova).
 *  - ativo   → bot_ativo / aguardando_confirmacao_cotacao: coleta + decisão.
 *  - holding → cotação/equipe, apólice, VIP: só acolhe.
 *  - mudo    → encerrado, e humano_assumiu QUANDO um operador é o dono (clicou
 *              "Assumir"): a Bia não fala por cima do humano. Reversível via
 *              "devolver ao robô" (volta para bot_ativo).
 *
 * Nota sobre humano_assumiu SEM dono: o estado também é setado pelo handoff
 * automático (ex.: cotação falhou) antes de qualquer operador pegar a conversa.
 * Nesse caso `operadorId` é null e a Bia segue em holding (acolhe; "sempre
 * responde") para não deixar o cliente no vácuo até alguém assumir.
 */
export function decidirModoBia(estado: string, operadorId?: string | null): ModoBia {
  if (estado === "bot_ativo" || estado === "aguardando_confirmacao_cotacao") return "ativo";
  if (estado === "encerrado") return "mudo";
  if (estado === "humano_assumiu") return operadorId ? "mudo" : "holding";
  return "holding"; // cotação/equipe + apolice_emitida + bloqueado_vip
}

/** 1ª linha do bloco de holding, conforme o estado (explica quem está cuidando). */
export function contextoHoldingPorEstado(estado: string): string {
  if (ESTADOS_EQUIPE_TRABALHANDO.has(estado)) {
    return "MODO DE ATENDIMENTO: a equipe já está preparando a cotação deste cliente.";
  }
  if (estado === "apolice_emitida") {
    return "MODO DE ATENDIMENTO: a apólice deste cliente já foi emitida; um corretor cuida de ajustes.";
  }
  if (estado === "bloqueado_vip") {
    return "MODO DE ATENDIMENTO: cliente VIP — um atendente dedicado vai assumir.";
  }
  return "MODO DE ATENDIMENTO: um corretor humano já assumiu este atendimento.";
}

/**
 * Gera (via Claude) UMA mensagem proativa da Bia para o cliente, seguindo uma
 * instrução opcional do operador (ex.: "peça os documentos do veículo"). NÃO
 * envia nem persiste — devolve só o texto; quem entrega é a rota /bia-gerar via
 * sessionManager.enviarTextoBot. Reaproveita o mesmo brain (system prompt +
 * chamarBia) do fluxo reativo, então a voz da Bia é a mesma. Retorna null se a
 * conversa não existir ou a Claude não produzir texto.
 */
export async function gerarMensagemBia(
  conversaId: string,
  instrucao?: string,
): Promise<string | null> {
  const conversa = await carregarConversa(conversaId);
  if (!conversa) return null;

  const progresso = calcularProgresso(conversa.categoria, conversa.dados_coletados);
  const systemDinamico = buildSystemPromptDinamico({
    categoria: conversa.categoria,
    contextoRAG: "",
    dadosColetados: conversa.dados_coletados,
    pendentesObrigatorios: progresso.pendentesObrigatorios,
    proximoCampo: progresso.pendentesObrigatorios[0] ?? null,
    campoForcado: null,
    modo: "holding",
    contextoHolding:
      "MODO DE ATENDIMENTO: o operador pediu que você (Bia) envie uma mensagem proativa ao cliente AGORA.",
    oferecerModalidade: false,
    pedirConfirmacaoCotacao: false,
  });

  const instr =
    instrucao && instrucao.trim()
      ? instrucao.trim()
      : "Envie uma mensagem proativa, cordial e curta retomando o atendimento com o cliente.";
  const turno =
    `[INSTRUÇÃO DO OPERADOR — escreva UMA mensagem de WhatsApp ao cliente seguindo isto. ` +
    `Não faça perguntas de roteiro nem use ferramentas, a menos que a instrução peça]: ${instr}`;

  // Anthropic exige histórico alternado começando por user; carregarHistorico já
  // devolve compactado. Anexa a instrução: concatena se o último turno for user,
  // senão acrescenta um turno user (ou cria um, se o histórico estiver vazio).
  const historico = await carregarHistorico(conversaId);
  const msgs: MensagemTurno[] = [...historico];
  const ultimo = msgs[msgs.length - 1];
  if (ultimo && ultimo.role === "user") {
    msgs[msgs.length - 1] = { role: "user", content: `${ultimo.content}\n\n${turno}` };
  } else {
    msgs.push({ role: "user", content: turno });
  }

  const resposta = await chamarBia({
    systemBase: SYSTEM_PROMPT_BASE,
    systemDinamico,
    historico: msgs,
  });
  return resposta.texto?.trim() || null;
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

/**
 * Cliente recorrente em modo REVISÃO de dados? (flag semeada na criação/reabertura
 * da conversa em persistence.ts). Quando true, a Bia apresenta tudo de uma vez e
 * pergunta se mudou algo, em vez de re-perguntar campo a campo. Função pura.
 */
export function emRevisao(dadosBot: Record<string, unknown>): boolean {
  return (dadosBot as { revisao_pendente?: unknown }).revisao_pendente === true;
}

/** Nº de turnos sem o cliente confirmar a revisão (anti-loop). Defensivo. */
function lerTentativasRevisao(dadosBot: Record<string, unknown>): number {
  const raw = (dadosBot as { revisao_tentativas?: unknown }).revisao_tentativas;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
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
 * Crítica COMPLETA de dados para a cotação (cpf ausente/inválido, placa, cep),
 * re-derivada via `mapearParaCotacao`. Vazio quando os dados estão ok (a falha
 * foi por outro motivo: Segfy off, 422, etc.). Best-effort — nunca lança.
 */
async function derivarCotacaoFaltando(
  sb: ReturnType<typeof getSupabaseAdmin>,
  clienteId: string,
  dados: Record<string, unknown>,
): Promise<string[]> {
  try {
    const { data } = await sb.from("clientes").select("cpf, nome").eq("id", clienteId).maybeSingle();
    const cli = data as { cpf?: string | null; nome?: string | null } | null;
    const { faltando } = mapearParaCotacao(dados, { cpf: cli?.cpf ?? null, nome: cli?.nome ?? null });
    return faltando;
  } catch {
    return [];
  }
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
  // Estado ANTES do disparo — usado para não re-escalar em retries (idempotência):
  // se a conversa já estava com um humano, uma nova falha não re-notifica.
  const { data: pre } = await sb
    .from("conversas")
    .select("estado, dados_bot, ramo, corretora_id")
    .eq("id", p.conversaId)
    .maybeSingle();
  const estadoInicial = (pre as { estado?: string } | null)?.estado;
  const dadosBot = comoObjeto((pre as { dados_bot?: Record<string, unknown> | null } | null)?.dados_bot);
  // Ramo e corretora da conversa decidem o provider (auto→Segfy; demais→manual)
  // e o tenant da cotação. Ausentes (conversa antiga) → auto / corretora seed.
  const ramoConversa = (pre as { ramo?: string | null } | null)?.ramo ?? null;
  const corretoraConversa = (pre as { corretora_id?: string | null } | null)?.corretora_id ?? undefined;

  await sb.from("conversas").update({ estado: "aguardando_cotacao" }).eq("id", p.conversaId);

  // Sessão do Segfy caída (pré-check) lança SegfyReauthNecessariaError ANTES de
  // criar a cotação (sem card "parou em Autenticação"). Tratamos como "não cotou"
  // → escala p/ humano (o operador já foi avisado p/ reautenticar).
  let cotacao;
  try {
    cotacao = await dispararCotacao({
      conversaId: p.conversaId,
      clienteId: p.clienteId,
      dados: p.dados,
      ramo: ramoConversa,
      corretoraId: corretoraConversa,
    });
  } catch (e) {
    if (e instanceof SegfyReauthNecessariaError) cotacao = null;
    else throw e;
  }
  if (!cotacao) {
    // Cotação falhou (Segfy off / dados faltando / erro): escala para um humano
    // (a trigger do banco notifica os operadores). A conversa fica em holding —
    // a Bia continua respondendo. Só escala se já não estava com humano.
    // Marca a falha em dados_bot ANTES do handoff: o trigger de handoff usa isso
    // para NÃO emitir o aviso genérico (o aviso específico vem do trg_cotacoes_desfecho).
    // `cotacao_faltando` = crítica COMPLETA (dados ausentes/ inválidos) p/ a tela
    // destacar todos os campos; vazio quando a falha não foi por dados.
    const faltando = await derivarCotacaoFaltando(sb, p.clienteId, p.dados);
    await mergeDadosBot(p.conversaId, dadosBot, { cotacao_em_falha: true, cotacao_faltando: faltando });
    if (estadoInicial !== "humano_assumiu") {
      await executarHandoff({ conversaId: p.conversaId, motivo: "cotacao_falhou" });
    }
    return { cotou: false };
  }
  try {
    await mergeDadosBot(p.conversaId, dadosBot, { cotacao_em_falha: false, cotacao_faltando: [] });
    // NOVO FLUXO (escolha manual): NÃO enviamos o comparativo automaticamente.
    // A cotação já foi persistida como 'concluida' e aparece em "Cotações
    // pendentes" no board /chamados; lá o OPERADOR escolhe UMA opção e só ela é
    // enviada ao cliente (POST /api/cotacao/:cotacaoId/escolher, que então move a
    // conversa para 'cotacao_enviada'). Aqui a conversa permanece em
    // 'aguardando_cotacao' — o gatilho trg_cotacoes_desfecho avisa os operadores.
    logger.info("[bot] cotação Segfy concluída; aguardando escolha do operador", {
      conversaId: p.conversaId,
    });
  } catch (e) {
    logger.error("[bot] falha ao finalizar cotação (pós-conclusão)", {
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
  /**
   * Dispara o alerta de handoff ao operador (best-effort, fora do thread do
   * cliente). Opcional: ausente em rotas/testes; quando ausente, nada acontece.
   * Nunca deve lançar de forma a interromper o handoff.
   */
  alertarOperador?: (motivo: MotivoHandoff) => Promise<void>;
}

/**
 * Dispara o alerta de handoff ao operador sem nunca propagar erro. Isolado do
 * `executarHandoff` de propósito: o alerta é um efeito colateral opcional e a
 * transferência do cliente jamais pode falhar por causa dele.
 */
async function dispararAlerta(
  input: ProcessarMensagemInput,
  motivo: MotivoHandoff,
  conversaId: string,
): Promise<void> {
  if (!input.alertarOperador) return;
  try {
    await input.alertarOperador(motivo);
  } catch (e) {
    logger.warn("[bot] alerta de handoff falhou (handoff preservado)", {
      conversaId,
      motivo,
      erro: (e as Error).message,
    });
  }
}

export async function processarMensagem(input: ProcessarMensagemInput): Promise<void> {
  const env = getEnv();
  if (!env.BIA_ENABLED) {
    logger.info("[bot] BIA_ENABLED=false; ignorando mensagem", {
      conversaId: input.conversaId,
    });
    return;
  }

  // Master switch da LINHA (canal). bot_ativo=false → silêncio total: a Bia não
  // responde, não acolhe, não detecta handoff nesta linha (só humanos). Gate
  // anterior a tudo, por canalId (independe de a conversa já existir).
  // FAIL-OPEN: erro de leitura devolve true (ver lerBotAtivoCanal).
  if (!(await lerBotAtivoCanal(input.canalId))) {
    logger.info("[bot] bot_ativo=false na linha; silêncio total", {
      conversaId: input.conversaId,
      canalId: input.canalId,
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
  //    - mudo    → não responde (só `encerrado`; nova msg já reabriu como nova conversa).
  //    - ativo   → fluxo completo (coleta / confirmação).
  //    - holding → equipe/corretor cuidando: a Bia ACOLHE (nunca cala), sem coletar.
  const modo = decidirModoBia(conversa.estado, conversa.operador_id);

  if (modo === "mudo") {
    logger.info("[bot] modo mudo; nao respondendo", {
      conversaId: conversa.id,
      estado: conversa.estado,
    });
    return;
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
    // Alerta ao operador (best-effort, SEMPRE o último passo): falha aqui não
    // pode desfazer nem interromper o handoff já executado acima.
    await dispararAlerta(input, classificarMotivoHandoff(gatilho.gatilho ?? ""), conversa.id);
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
      await dispararAlerta(input, "vip", conversa.id);
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
  // Cliente recorrente: apresentar os dados de uma vez e perguntar se mudou algo.
  const revisaoPendente = modo === "ativo" && !ehConfirmacao && emRevisao(conversa.dados_bot);
  const oferecerModalidade =
    !ehConfirmacao &&
    !revisaoPendente &&
    modo === "ativo" &&
    deveOferecerModalidade({
      categoria: conversa.categoria,
      dadosBot: conversa.dados_bot,
      dadosColetados: conversa.dados_coletados,
    });

  // 3.1) Comportamento configurável por linha (Admin > Bia): tom/persona/saudação/
  //       exemplos/temperatura + campos da cotação (quais perguntar + customizadas).
  //       Degrada com segurança: erro/ausência → null → a Bia roda como antes.
  let configAgente = null;
  try {
    configAgente = await obterConfigEfetiva(conversa.canal_id);
  } catch (e) {
    logger.warn("[bot] config do agente falhou; seguindo sem personalização", {
      conversaId: conversa.id,
      erro: (e as Error).message,
    });
  }
  // Campos da cotação resolvidos para ESTA categoria (vazio em duvida/outro).
  const catKey = conversa.categoria ?? "";
  const camposExcluidos = configAgente?.camposExcluidos?.[catKey] ?? [];
  const camposCustom = configAgente?.perguntasCustomizadas?.[catKey] ?? [];

  const systemDinamico = buildSystemPromptDinamico({
    categoria: conversa.categoria,
    contextoRAG: contextoTexto,
    dadosColetados: conversa.dados_coletados,
    pendentesObrigatorios: progresso.pendentesObrigatorios,
    proximoCampo,
    campoForcado,
    modo,
    contextoHolding: modo === "holding" ? contextoHoldingPorEstado(conversa.estado) : undefined,
    oferecerModalidade,
    pedirConfirmacaoCotacao: ehConfirmacao,
    revisaoPendente,
    camposExcluidos,
    camposCustom,
  });

  // 3.2) Diretrizes aprendidas (Admin > Aprendizado): playbook destilado do
  //       histórico, injetado como bloco cacheado. Só no fluxo ativo e atrás do
  //       toggle do banco (controle do usuário, não mais env). Fail-closed na
  //       leitura do toggle; fail-open na leitura do playbook: erro/sem versão
  //       ativa → "" → a Bia roda como antes.
  const aprendizadoLigado = await lerAprendizadoAtivo();
  let aprendizadoTexto = "";
  if (aprendizadoLigado && modo === "ativo") {
    try {
      aprendizadoTexto = await obterPlaybookAtivoTexto(conversa.categoria);
    } catch (e) {
      logger.warn("[bot] playbook falhou; seguindo sem diretrizes", {
        conversaId: conversa.id,
        erro: (e as Error).message,
      });
    }
  }

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
      permitirRevisao: revisaoPendente,
      systemPersonalizacao: configAgente ? buildBlocoPersonalizacao(configAgente) : undefined,
      systemAprendizado: aprendizadoTexto || undefined,
      temperature: configAgente?.temperature,
      chavesExtras: camposCustom.map((c) => c.chave),
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
    // CPF é fonte única: ao coletar um CPF válido, espelha no cadastro.
    const cpfColetado = resposta.camposExtraidos.cpf;
    if (typeof cpfColetado === "string" && cpfValido(cpfColetado)) {
      const sb = getSupabaseAdmin();
      await sb.from("clientes").update({ cpf: formatarCpf(cpfColetado) }).eq("id", conversa.cliente_id);
    }
    // Telefone: quando o cliente informa (porque o jid era @lid e pedimos), grava
    // o número REAL normalizado no cadastro — corrige o fallback derivado do LID.
    const telColetado = resposta.camposExtraidos.telefone_contato ?? resposta.camposExtraidos.telefone;
    const telNorm = typeof telColetado === "string" ? normalizarTelefoneBr(telColetado) : null;
    if (telNorm) {
      const sb = getSupabaseAdmin();
      await sb.from("clientes").update({ telefone: telNorm }).eq("id", conversa.cliente_id);
    }
    // Endereço: quando o cliente passa CEP/número/complemento (ou a consulta de
    // CEP resolve o logradouro), espelha o endereço ESTRUTURADO no cadastro
    // (clientes.endereco JSONB). Monta a partir do merge cumulativo dos dados —
    // nunca grava endereço pela metade, só inclui chaves presentes. Best-effort.
    const CHAVES_ENDERECO = ["cep", "numero", "complemento", "logradouro", "bairro", "cidade", "uf"] as const;
    if (CHAVES_ENDERECO.some((k) => k in resposta.camposExtraidos)) {
      const merged = { ...conversa.dados_coletados, ...resposta.camposExtraidos } as Record<string, unknown>;
      const endereco: Record<string, string> = {};
      for (const k of CHAVES_ENDERECO) {
        const v = merged[k];
        if (typeof v === "string" && v.trim() !== "") endereco[k] = v.trim();
      }
      if (Object.keys(endereco).length > 0) {
        const sb = getSupabaseAdmin();
        await sb.from("clientes").update({ endereco }).eq("id", conversa.cliente_id);
      }
    }
  }

  // 7.1) Dequeue da fila de campos forçados: remove os que já foram preenchidos
  //      (pelo operador ou agora pelo cliente). Best-effort, não bloqueia a resposta.
  await sincronizarFilaForcada(conversa.id, conversa.dados_bot, {
    ...conversa.dados_coletados,
    ...resposta.camposExtraidos,
  });

  // 8) Enviar a resposta da Bia ao cliente (se houver texto).
  await enviarRespostaBia(resposta.texto, input.enviar, conversa.id);

  // 8.05) Revisão do cliente recorrente: ele acabou de ver todos os dados de uma
  //       vez. NÃO deixa o fluxo cair em finalizarSeRoteiroCompleto enquanto a
  //       revisão não for respondida (evita pular para a cotação sem confirmar).
  if (revisaoPendente) {
    if (typeof resposta.revisaoMudou === "boolean") {
      // Cliente respondeu (tudo certo OU informou mudanças — já mescladas no bloco 7):
      // encerra a revisão e segue o fluxo normal (se completo → confirmação de cotação).
      await mergeDadosBot(conversa.id, conversa.dados_bot, {
        revisao_pendente: false,
        revisao_tentativas: 0,
      });
      const dadosPos = { ...conversa.dados_coletados, ...resposta.camposExtraidos };
      await finalizarSeRoteiroCompleto({
        conversaId: conversa.id,
        categoria: conversa.categoria,
        dados: dadosPos,
      });
    } else {
      // Cliente ainda não confirmou: mantém a revisão, com teto (na 2ª tentativa
      // sem resposta clara, abandona a revisão e segue a coleta normal no próximo turno).
      const tentativas = lerTentativasRevisao(conversa.dados_bot) + 1;
      await mergeDadosBot(
        conversa.id,
        conversa.dados_bot,
        tentativas >= 2
          ? { revisao_pendente: false, revisao_tentativas: 0 }
          : { revisao_tentativas: tentativas },
      );
    }
    return;
  }

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
  mergeDadosColetados,
};
