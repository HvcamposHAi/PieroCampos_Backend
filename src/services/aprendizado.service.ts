/**
 * Aprendizado contínuo da Bia — "playbook destilado" a partir do histórico.
 *
 * Ideia: um job (botão do Admin ou pinger) seleciona conversas ENCERRADAS,
 * rotula cada uma como sucesso/falha pelo funil (conversas→cotacoes→propostas→
 * apolices), e o próprio Claude destila DIRETRIZES por categoria — o que
 * POTENCIALIZAR (padrões que convertem) e o que EVITAR (antipadrões). As
 * diretrizes nascem como `rascunho` (efeito zero) e só influenciam a Bia depois
 * que um admin ATIVA a versão. Em runtime, `obterPlaybookAtivoTexto` devolve o
 * bloco da versão ativa para injeção (cacheada) no system prompt.
 *
 * Tabelas (service_role, sem RLS — espelha canal_agente_config/wa_auth_state):
 *   aprendizado_playbook | aprendizado_job | aprendizado_amostra
 *
 * Zero impacto: leitura de runtime é FAIL-OPEN (erro/sem ativo → ""); o job só
 * roda quando disparado; nada altera tabelas existentes.
 */
import { getSupabaseAdmin } from "../integrations/whatsapp/supabase";
import { destilar, type DiretrizesPlaybook } from "../integrations/claude/aprendizado.client";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";

// ----------------------------------------------------------------------------
// Constantes de seleção/destilação
// ----------------------------------------------------------------------------
const BATCH_MAX = 200;
const JANELA_INICIAL_DIAS = 90;
const STALE_MINUTOS = 15;
/** Mínimo de conversas rotuladas (com ≥1 sucesso e ≥1 falha) para destilar um segmento. */
const MIN_SINAL = 4;
const MAX_TRANSCRICOES_POR_LADO = 12;
const MAX_TURNOS = 40;
const MAX_CORPO = 500;

const ESTADOS_ELEGIVEIS = ["encerrado", "apolice_emitida", "humano_assumiu"];

export type Resultado = "sucesso" | "falha" | "indeterminado";

// ----------------------------------------------------------------------------
// Rotulagem (pura — testável isoladamente)
// ----------------------------------------------------------------------------
export interface FunilConversa {
  estado: string;
  cotacoes: Array<{ status: string | null; aceito_em: string | null }>;
  propostas: Array<{ status: string | null }>;
  temApolice: boolean;
}

/** Classifica uma conversa pelo desfecho no funil. Ordem: sucesso > falha > indeterminado. */
export function rotularResultado(f: FunilConversa): { resultado: Resultado; motivo: string } {
  const propPositiva = f.propostas.some((p) => p.status === "emitida" || p.status === "aprovada");
  const cotacaoAceita = f.cotacoes.some((c) => c.aceito_em != null);
  if (f.temApolice || propPositiva || cotacaoAceita || f.estado === "apolice_emitida") {
    const motivo = f.temApolice
      ? "apólice emitida"
      : propPositiva
        ? "proposta aprovada/emitida"
        : cotacaoAceita
          ? "cotação aceita"
          : "estado apolice_emitida";
    return { resultado: "sucesso", motivo };
  }
  const cotacaoErro = f.cotacoes.some((c) => c.status === "erro" || c.status === "expirada");
  const propRecusada = f.propostas.some((p) => p.status === "recusada");
  const encerradoSemFecho = f.estado === "encerrado";
  if (cotacaoErro || propRecusada || encerradoSemFecho) {
    const motivo = propRecusada
      ? "proposta recusada"
      : cotacaoErro
        ? "cotação com erro/expirada"
        : "encerrado sem fechamento";
    return { resultado: "falha", motivo };
  }
  return { resultado: "indeterminado", motivo: "sem desfecho no funil" };
}

// ----------------------------------------------------------------------------
// Redação de PII (defesa em profundidade — o prompt também pede para não copiar)
// ----------------------------------------------------------------------------
const RE_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const RE_CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const RE_TELEFONE = /\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g;
const RE_CEP = /\b\d{5}-?\d{3}\b/g;
const RE_PLACA = /\b[A-Z]{3}-?\d[A-Z0-9]\d{2}\b/g;

export function redigirPII(texto: string): string {
  return texto
    .replace(RE_EMAIL, "[email]")
    .replace(RE_CPF, "[cpf]")
    .replace(RE_CEP, "[cep]")
    .replace(RE_TELEFONE, "[telefone]")
    .replace(RE_PLACA, "[placa]");
}

// ----------------------------------------------------------------------------
// Serialização do playbook → bloco do system prompt (puro, DETERMINÍSTICO)
// ----------------------------------------------------------------------------
/**
 * Converte as diretrizes no texto que entra no system prompt. Sem timestamps
 * nem dados variáveis: para a mesma versão, o texto é byte-estável (cache).
 * Diretrizes vazias → "" (nada a injetar).
 */
export function montarTextoPlaybook(d: DiretrizesPlaybook): string {
  const pad = d.padroes_que_convertem ?? [];
  const anti = d.antipadroes_a_evitar ?? [];
  if (pad.length === 0 && anti.length === 0) return "";
  const partes: string[] = ["DIRETRIZES APRENDIDAS (do histórico de atendimentos desta corretora):"];
  if (pad.length > 0) {
    partes.push("");
    partes.push("O que POTENCIALIZAR (padrões que mais convertem):");
    for (const p of pad) partes.push(`- ${redigirPII(p.diretriz)}`);
  }
  if (anti.length > 0) {
    partes.push("");
    partes.push("O que EVITAR (associado a atendimentos que NÃO fecharam):");
    for (const a of anti) partes.push(`- ${redigirPII(a.diretriz)}`);
  }
  partes.push("");
  partes.push(
    "Use estas diretrizes como orientação de estilo e estratégia. Elas NÃO sobrepõem as regras absolutas de compliance/LGPD nem o roteiro de coleta.",
  );
  return partes.join("\n");
}

// ----------------------------------------------------------------------------
// Runtime: leitura do playbook ativo (FAIL-OPEN)
// ----------------------------------------------------------------------------
/**
 * Texto da versão ATIVA mais específica para o segmento. Preferência:
 * (categoria, ramo) → (categoria, null) → (null, null). Erro/sem ativo → "".
 */
export async function obterPlaybookAtivoTexto(
  categoria: string | null,
  ramo: string | null = null,
): Promise<string> {
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("aprendizado_playbook")
      .select("categoria, ramo, texto_prompt")
      .eq("status", "ativo");
    if (error) {
      logger.warn("[aprendizado] leitura do playbook falhou; sem diretrizes", { erro: error.message });
      return "";
    }
    const linhas = (data ?? []) as Array<{ categoria: string | null; ramo: string | null; texto_prompt: string }>;
    if (linhas.length === 0) return "";
    const escolha =
      linhas.find((l) => l.categoria === categoria && l.ramo === ramo) ??
      linhas.find((l) => l.categoria === categoria && l.ramo === null) ??
      linhas.find((l) => l.categoria === null && l.ramo === null) ??
      null;
    return escolha?.texto_prompt?.trim() ? escolha.texto_prompt : "";
  } catch (e) {
    logger.warn("[aprendizado] exceção lendo playbook; sem diretrizes", { erro: (e as Error).message });
    return "";
  }
}

// ----------------------------------------------------------------------------
// Toggle global (Admin › Aprendizado) — fonte de verdade do liga/desliga
// ----------------------------------------------------------------------------
// Substitui a antiga env APRENDIZADO_ENABLED no gate de runtime: o controle agora
// é do usuário, via botão na UI, persistido em `aprendizado_config` (singleton).
// Lido a cada mensagem (cache curto, espelha o padrão de lerBotAtivoCanal).
// FAIL-CLOSED: erro de leitura → false → a Bia se comporta como hoje (sem
// diretrizes injetadas). Injetar é mudança aditiva de comportamento; o default
// seguro é "não mudar nada".
let _cacheAtivo: { valor: boolean; em: number } | null = null;
const APRENDIZADO_TTL_MS = 30_000;

export async function lerAprendizadoAtivo(): Promise<boolean> {
  const agora = Date.now();
  if (_cacheAtivo && agora - _cacheAtivo.em < APRENDIZADO_TTL_MS) return _cacheAtivo.valor;
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("aprendizado_config")
      .select("ativo")
      .eq("id", true)
      .maybeSingle();
    if (error) {
      logger.warn("[aprendizado] leitura do toggle falhou; fail-closed (off)", { erro: error.message });
      return false; // NÃO cacheia erro → re-tenta na próxima mensagem
    }
    const v = (data as { ativo?: boolean } | null)?.ativo === true;
    _cacheAtivo = { valor: v, em: agora };
    return v;
  } catch (e) {
    logger.warn("[aprendizado] exceção lendo toggle; fail-closed (off)", { erro: (e as Error).message });
    return false;
  }
}

/** Liga/desliga o toggle global. Upsert na linha singleton + invalida o cache. */
export async function definirAprendizadoAtivo(ativo: boolean, porEmail: string | null): Promise<void> {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("aprendizado_config").upsert(
    { id: true, ativo, atualizado_em: new Date().toISOString(), atualizado_por: porEmail },
    { onConflict: "id" },
  );
  if (error) throw new Error(`definirAprendizadoAtivo: ${error.message}`);
  _cacheAtivo = { valor: ativo, em: Date.now() }; // reflete na hora dentro do processo
  logger.info("[aprendizado] toggle alterado", { ativo, por: porEmail });
}

/** Apenas para testes: zera o cache do toggle. */
export function _resetAprendizadoConfigCache(): void {
  _cacheAtivo = null;
}

// ----------------------------------------------------------------------------
// Seleção + rotulagem de conversas (job)
// ----------------------------------------------------------------------------
export interface ConversaRotulada {
  conversaId: string;
  clienteId: string | null;
  categoria: string | null;
  ramo: string | null;
  resultado: Resultado;
  motivo: string;
  transcricao: string;
}

function montarTranscricao(
  msgs: Array<{ origem: string | null; corpo: string | null }>,
): string {
  const ultimas = msgs.slice(-MAX_TURNOS);
  const linhas: string[] = [];
  for (const m of ultimas) {
    const corpo = (m.corpo ?? "").trim();
    if (!corpo) continue;
    const quem = m.origem === "cliente" ? "Cliente" : m.origem === "operador" ? "Equipe" : "Bia";
    linhas.push(`${quem}: ${redigirPII(corpo).slice(0, MAX_CORPO)}`);
  }
  return linhas.join("\n");
}

/**
 * Seleciona conversas encerradas na janela (ainda não amostradas) e as rotula
 * pelo funil. Faz poucas queries e junta em memória (volume baixo).
 */
export async function selecionarConversasRotuladas(
  janelaDe: string,
  janelaAte: string,
  batchMax: number = BATCH_MAX,
): Promise<ConversaRotulada[]> {
  const sb = getSupabaseAdmin();

  const { data: convData, error: convErr } = await sb
    .from("conversas")
    .select("id, cliente_id, categoria, estado")
    .is("deletado_em", null)
    .in("estado", ESTADOS_ELEGIVEIS)
    .gte("criado_em", janelaDe)
    .lt("criado_em", janelaAte)
    .order("criado_em", { ascending: false })
    .limit(batchMax);
  if (convErr) throw new Error(`selecionar(conversas): ${convErr.message}`);
  let conversas = (convData ?? []) as Array<{
    id: string;
    cliente_id: string | null;
    categoria: string | null;
    estado: string;
  }>;
  if (conversas.length === 0) return [];

  // Idempotência: descarta conversas já amostradas em jobs anteriores.
  const { data: amData } = await sb.from("aprendizado_amostra").select("conversa_id");
  const jaVistas = new Set((amData ?? []).map((r) => (r as { conversa_id: string }).conversa_id));
  conversas = conversas.filter((c) => !jaVistas.has(c.id));
  if (conversas.length === 0) return [];

  const conversaIds = conversas.map((c) => c.id);

  // Funil: cotacoes → propostas → apolices, e mensagens (transcrição).
  const [cotRes, msgRes] = await Promise.all([
    sb
      .from("cotacoes")
      .select("id, conversa_id, status, aceito_em, ramo")
      .in("conversa_id", conversaIds),
    sb
      .from("mensagens")
      .select("conversa_id, origem, corpo, enviada_em")
      .in("conversa_id", conversaIds)
      .order("enviada_em", { ascending: true }),
  ]);
  if (cotRes.error) throw new Error(`selecionar(cotacoes): ${cotRes.error.message}`);
  if (msgRes.error) throw new Error(`selecionar(mensagens): ${msgRes.error.message}`);
  const cotacoes = (cotRes.data ?? []) as Array<{
    id: string;
    conversa_id: string;
    status: string | null;
    aceito_em: string | null;
    ramo: string | null;
  }>;
  const cotacaoIds = cotacoes.map((c) => c.id);

  let propostas: Array<{ id: string; cotacao_id: string; status: string | null }> = [];
  let apolices: Array<{ proposta_id: string | null }> = [];
  if (cotacaoIds.length > 0) {
    const propRes = await sb
      .from("propostas")
      .select("id, cotacao_id, status")
      .in("cotacao_id", cotacaoIds);
    if (propRes.error) throw new Error(`selecionar(propostas): ${propRes.error.message}`);
    propostas = (propRes.data ?? []) as typeof propostas;
    const propIds = propostas.map((p) => p.id);
    if (propIds.length > 0) {
      const apoRes = await sb.from("apolices").select("proposta_id").in("proposta_id", propIds);
      if (apoRes.error) throw new Error(`selecionar(apolices): ${apoRes.error.message}`);
      apolices = (apoRes.data ?? []) as typeof apolices;
    }
  }

  const propostasComApolice = new Set(
    apolices.map((a) => a.proposta_id).filter((x): x is string => !!x),
  );
  const msgsPorConversa = new Map<string, Array<{ origem: string | null; corpo: string | null }>>();
  for (const m of (msgRes.data ?? []) as Array<{
    conversa_id: string;
    origem: string | null;
    corpo: string | null;
  }>) {
    const arr = msgsPorConversa.get(m.conversa_id) ?? [];
    arr.push({ origem: m.origem, corpo: m.corpo });
    msgsPorConversa.set(m.conversa_id, arr);
  }

  const out: ConversaRotulada[] = [];
  for (const c of conversas) {
    const cotsDaConversa = cotacoes.filter((x) => x.conversa_id === c.id);
    const cotIdsConversa = new Set(cotsDaConversa.map((x) => x.id));
    const propsDaConversa = propostas.filter((p) => cotIdsConversa.has(p.cotacao_id));
    const temApolice = propsDaConversa.some((p) => propostasComApolice.has(p.id));
    const { resultado, motivo } = rotularResultado({
      estado: c.estado,
      cotacoes: cotsDaConversa.map((x) => ({ status: x.status, aceito_em: x.aceito_em })),
      propostas: propsDaConversa.map((p) => ({ status: p.status })),
      temApolice,
    });
    const ramo = cotsDaConversa.find((x) => x.ramo)?.ramo ?? null;
    out.push({
      conversaId: c.id,
      clienteId: c.cliente_id,
      categoria: c.categoria,
      ramo,
      resultado,
      motivo,
      transcricao: montarTranscricao(msgsPorConversa.get(c.id) ?? []),
    });
  }
  return out;
}

// ----------------------------------------------------------------------------
// Job de destilação
// ----------------------------------------------------------------------------
export interface ResultadoDistillacao {
  ok: boolean;
  motivo?: string;
  jobId?: string;
  conversasTotal?: number;
  versoesGeradas?: number;
}

function isoSubtraindoDias(dias: number): string {
  const agora = Date.now();
  return new Date(agora - dias * 24 * 60 * 60 * 1000).toISOString();
}

async function reaperJobsTravados(sb: ReturnType<typeof getSupabaseAdmin>): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_MINUTOS * 60 * 1000).toISOString();
  await sb
    .from("aprendizado_job")
    .update({ status: "erro", erro: "timeout (reaper)", concluido_em: new Date().toISOString() })
    .eq("status", "rodando")
    .lt("criado_em", cutoff);
}

async function proximaVersao(
  sb: ReturnType<typeof getSupabaseAdmin>,
  categoria: string | null,
): Promise<number> {
  let q = sb.from("aprendizado_playbook").select("versao").order("versao", { ascending: false }).limit(1);
  q = categoria === null ? q.is("categoria", null) : q.eq("categoria", categoria);
  const { data } = await q;
  const ultima = (data?.[0] as { versao?: number } | undefined)?.versao ?? 0;
  return ultima + 1;
}

/** Agrupa rotuladas por categoria; segmentos fracos caem no bucket global (null). */
export function montarSegmentos(
  rotuladas: ConversaRotulada[],
): Array<{ categoria: string | null; itens: ConversaRotulada[] }> {
  const porCategoria = new Map<string, ConversaRotulada[]>();
  for (const r of rotuladas) {
    if (r.resultado === "indeterminado") continue;
    const chave = r.categoria ?? "__null__";
    const arr = porCategoria.get(chave) ?? [];
    arr.push(r);
    porCategoria.set(chave, arr);
  }
  const segmentos: Array<{ categoria: string | null; itens: ConversaRotulada[] }> = [];
  const fracos: ConversaRotulada[] = [];
  for (const [chave, itens] of porCategoria) {
    const temSinal =
      itens.length >= MIN_SINAL &&
      itens.some((i) => i.resultado === "sucesso") &&
      itens.some((i) => i.resultado === "falha");
    if (chave !== "__null__" && temSinal) {
      segmentos.push({ categoria: chave, itens });
    } else {
      fracos.push(...itens);
    }
  }
  // Bucket global: junta os fracos (+ os já sem categoria) se houver sinal mínimo.
  const globalTemSinal =
    fracos.length >= MIN_SINAL &&
    fracos.some((i) => i.resultado === "sucesso") &&
    fracos.some((i) => i.resultado === "falha");
  if (globalTemSinal) segmentos.push({ categoria: null, itens: fracos });
  return segmentos;
}

/**
 * Dispara uma rodada de destilação. Idempotente: o índice parcial único
 * `aprendizado_job_um_rodando` impede dois jobs simultâneos. Roda de forma
 * detached (chamada pela rota com 202). Em erro, marca o job como 'erro'.
 */
export async function dispararDistillacao(opts: { disparadoPor: string }): Promise<ResultadoDistillacao> {
  const sb = getSupabaseAdmin();
  await reaperJobsTravados(sb);

  // Janela: do fim do último job concluído até agora (ou 90 dias na 1ª vez).
  const { data: ultimoJob } = await sb
    .from("aprendizado_job")
    .select("janela_ate")
    .eq("status", "concluido")
    .order("concluido_em", { ascending: false })
    .limit(1);
  const janelaDe =
    (ultimoJob?.[0] as { janela_ate?: string } | undefined)?.janela_ate ??
    isoSubtraindoDias(JANELA_INICIAL_DIAS);
  const janelaAte = new Date().toISOString();

  // Mutex: insere o job 'rodando'. Violação de unicidade → já há um rodando.
  const { data: jobData, error: jobErr } = await sb
    .from("aprendizado_job")
    .insert({ status: "rodando", disparado_por: opts.disparadoPor, janela_de: janelaDe, janela_ate: janelaAte })
    .select("id")
    .single();
  if (jobErr) {
    if ((jobErr as { code?: string }).code === "23505") {
      return { ok: false, motivo: "job_em_andamento" };
    }
    throw new Error(`dispararDistillacao(job): ${jobErr.message}`);
  }
  const jobId = (jobData as { id: string }).id;

  try {
    const rotuladas = await selecionarConversasRotuladas(janelaDe, janelaAte);
    const qtdSucesso = rotuladas.filter((r) => r.resultado === "sucesso").length;
    const qtdFalha = rotuladas.filter((r) => r.resultado === "falha").length;

    if (rotuladas.length > 0) {
      const linhas = rotuladas.map((r) => ({
        job_id: jobId,
        conversa_id: r.conversaId,
        cliente_id: r.clienteId,
        categoria: r.categoria,
        ramo: r.ramo,
        resultado: r.resultado,
        motivo: r.motivo,
      }));
      const { error } = await sb.from("aprendizado_amostra").insert(linhas);
      if (error) logger.warn("[aprendizado] falha gravando amostras", { erro: error.message });
    }

    const segmentos = montarSegmentos(rotuladas);
    let versoesGeradas = 0;
    const env = getEnv();

    for (const seg of segmentos) {
      const sucessos = seg.itens
        .filter((i) => i.resultado === "sucesso")
        .slice(0, MAX_TRANSCRICOES_POR_LADO)
        .map((i) => i.transcricao);
      const falhas = seg.itens
        .filter((i) => i.resultado === "falha")
        .slice(0, MAX_TRANSCRICOES_POR_LADO)
        .map((i) => ({ motivo: i.motivo, transcricao: i.transcricao }));

      const diretrizes = await destilar({
        segmento: seg.categoria ?? "geral",
        sucessos,
        falhas,
      });
      if (!diretrizes) continue; // segmento sem versão; segue os demais.

      const textoPrompt = montarTextoPlaybook(diretrizes);
      if (!textoPrompt) continue; // nada acionável; não cria rascunho vazio.

      const versao = await proximaVersao(sb, seg.categoria);
      const { error } = await sb.from("aprendizado_playbook").insert({
        versao,
        status: "rascunho",
        categoria: seg.categoria,
        ramo: null,
        diretrizes,
        texto_prompt: textoPrompt,
        origem_job_id: jobId,
        conversas_analisadas: seg.itens.length,
        qtd_sucesso: seg.itens.filter((i) => i.resultado === "sucesso").length,
        qtd_falha: seg.itens.filter((i) => i.resultado === "falha").length,
        janela_de: janelaDe,
        janela_ate: janelaAte,
        modelo: env.APRENDIZADO_MODEL,
        criado_por: opts.disparadoPor,
      });
      if (error) {
        logger.warn("[aprendizado] falha inserindo versão", { categoria: seg.categoria, erro: error.message });
        continue;
      }
      versoesGeradas++;
    }

    await sb
      .from("aprendizado_job")
      .update({
        status: "concluido",
        conversas_total: rotuladas.length,
        qtd_sucesso: qtdSucesso,
        qtd_falha: qtdFalha,
        versoes_geradas: versoesGeradas,
        concluido_em: new Date().toISOString(),
      })
      .eq("id", jobId);

    logger.info("[aprendizado] distillação concluída", {
      jobId,
      conversas: rotuladas.length,
      versoesGeradas,
    });
    return { ok: true, jobId, conversasTotal: rotuladas.length, versoesGeradas };
  } catch (e) {
    const msg = (e as Error).message;
    logger.error("[aprendizado] distillação falhou", { jobId, erro: msg });
    await sb
      .from("aprendizado_job")
      .update({ status: "erro", erro: msg.slice(0, 500), concluido_em: new Date().toISOString() })
      .eq("id", jobId);
    return { ok: false, motivo: "erro", jobId };
  }
}

// ----------------------------------------------------------------------------
// Admin: leitura + ativação/arquivamento
// ----------------------------------------------------------------------------
export interface PlaybookRow {
  id: string;
  versao: number;
  status: string;
  categoria: string | null;
  ramo: string | null;
  diretrizes: DiretrizesPlaybook;
  conversas_analisadas: number;
  qtd_sucesso: number;
  qtd_falha: number;
  criado_em: string;
  ativado_em: string | null;
  ativado_por: string | null;
}

export interface AprendizadoAdmin {
  versoes: PlaybookRow[];
  jobs: Array<Record<string, unknown>>;
  habilitado: boolean;
}

const COLUNAS_PLAYBOOK =
  "id, versao, status, categoria, ramo, diretrizes, conversas_analisadas, qtd_sucesso, qtd_falha, criado_em, ativado_em, ativado_por";

export async function obterAdmin(): Promise<AprendizadoAdmin> {
  const sb = getSupabaseAdmin();
  const [pbRes, jobRes] = await Promise.all([
    sb
      .from("aprendizado_playbook")
      .select(COLUNAS_PLAYBOOK)
      .neq("status", "arquivado")
      .order("criado_em", { ascending: false }),
    sb.from("aprendizado_job").select("*").order("criado_em", { ascending: false }).limit(10),
  ]);
  if (pbRes.error) throw new Error(`obterAdmin(playbook): ${pbRes.error.message}`);
  if (jobRes.error) throw new Error(`obterAdmin(jobs): ${jobRes.error.message}`);
  return {
    versoes: (pbRes.data ?? []) as PlaybookRow[],
    jobs: (jobRes.data ?? []) as Array<Record<string, unknown>>,
    habilitado: await lerAprendizadoAtivo(),
  };
}

/** Ativa uma versão: arquiva a ativa do mesmo segmento e ativa a escolhida. */
export async function ativarVersao(id: string, porEmail: string | null): Promise<void> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("aprendizado_playbook")
    .select("id, categoria, ramo")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`ativarVersao(busca): ${error.message}`);
  if (!data) throw new Error("versão não encontrada");
  const { categoria, ramo } = data as { categoria: string | null; ramo: string | null };

  // Arquiva a ativa atual do mesmo segmento (índice único garante no máx. 1).
  let qArq = sb.from("aprendizado_playbook").update({ status: "arquivado" }).eq("status", "ativo");
  qArq = categoria === null ? qArq.is("categoria", null) : qArq.eq("categoria", categoria);
  qArq = ramo === null ? qArq.is("ramo", null) : qArq.eq("ramo", ramo);
  const { error: arqErr } = await qArq;
  if (arqErr) throw new Error(`ativarVersao(arquivar): ${arqErr.message}`);

  const { error: ativErr } = await sb
    .from("aprendizado_playbook")
    .update({ status: "ativo", ativado_em: new Date().toISOString(), ativado_por: porEmail })
    .eq("id", id);
  if (ativErr) throw new Error(`ativarVersao(ativar): ${ativErr.message}`);
  logger.info("[aprendizado] versão ativada", { id, categoria, por: porEmail });
}

/** Arquiva uma versão (se era a ativa, o segmento volta ao comportamento base). */
export async function arquivarVersao(id: string): Promise<void> {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("aprendizado_playbook").update({ status: "arquivado" }).eq("id", id);
  if (error) throw new Error(`arquivarVersao: ${error.message}`);
  logger.info("[aprendizado] versão arquivada", { id });
}
