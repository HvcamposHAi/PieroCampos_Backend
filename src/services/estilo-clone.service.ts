/**
 * Clonagem AUTOMÁTICA do estilo do operador (Admin > Bia > "Clonar estilo do operador").
 *
 * Em vez de o admin colar mensagens à mão no campo `estilo_amostra`, este serviço
 * COLHE amostras do jeito REAL de o operador escrever no WhatsApp, de 3 fontes:
 *   - "linha":   mensagens que o operador DIGITOU no WhatsApp da linha, capturadas
 *                em `operador_estilo_corpus` (NÃO o histórico do banco, que pode ser
 *                sintético/IA — ver estilo-captura.ts);
 *   - "texto":   um trecho colado pelo admin (export ou avulso);
 *   - "arquivo": um .txt exportado do WhatsApp ("Exportar conversa").
 * Para texto/arquivo que sejam EXPORT do WhatsApp (vários remetentes), o admin
 * escolhe QUEM é o operador — só as falas dele alimentam o destilador. Toda fonte é
 * REDIGIDA de PII (reusa redigirPII) e então DESTILADA por Claude num perfil de
 * estilo limpo, devolvido para o admin REVISAR e salvar. NÃO persiste nada.
 *
 * Isolado do hot-path da Bia: só roda na rota /api/agente/estilo/gerar (gated por
 * ESTILO_CLONE_ENABLED). Escopo multi-tenant garantido por corretoraId + canal.
 */
import { getSupabaseAdmin } from "../integrations/whatsapp/supabase";
import { redigirPII } from "./aprendizado.service";
import { destilarEstilo } from "../integrations/claude/estilo.client";
import { logger } from "../utils/logger";

// Limites defensivos (custo/abuso e constraint do campo `estilo_amostra`).
const MAX_MENSAGENS = 200;
const MAX_CHARS_AMOSTRA = 8000; // espelha o limite do campo estilo_amostra
const MAX_LINHAS_FONTE = 8000;
const MAX_BYTES_FONTE = 200 * 1024; // 200 KB
const MIN_CORPO = 2;
const MAX_CORPO_AMOSTRA = 500;
const MAX_REMETENTES = 20;

export type FonteEstilo = "linha" | "texto" | "arquivo";

export interface GerarEstiloInput {
  corretoraId: string;
  fonte: FonteEstilo;
  /** Para fonte="linha": canal alvo. null = config padrão (toda a corretora). */
  canalId?: string | null;
  /** Para fonte="texto". */
  texto?: string;
  /** Para fonte="arquivo": conteúdo .txt em base64. */
  arquivoBase64?: string;
  /** Para texto/arquivo que sejam EXPORT do WhatsApp: nome do remetente = operador. */
  remetenteOperador?: string;
}

export interface GerarEstiloResult {
  amostra: string;
  nLinhasFonte: number;
  /** Quando o export tem >1 remetente e nenhum foi escolhido: pede para o admin escolher. */
  precisaRemetente?: boolean;
  remetentes?: string[];
}

// ----------------------------------------------------------------------------
// Coleta a partir da LINHA (corpus de mensagens REAIS digitadas pelo operador)
// ----------------------------------------------------------------------------
/**
 * Amostras do `operador_estilo_corpus` desta linha (já redigidas na captura;
 * redigimos de novo por garantia). Escopo SEMPRE por corretora: se `canalId`
 * informado, valida que o canal pertence à corretora (senão []); se null, varre
 * todos os canais da corretora.
 */
export async function coletarAmostrasDaLinha(
  corretoraId: string,
  canalId: string | null,
  limite: number = MAX_MENSAGENS,
): Promise<string[]> {
  const sb = getSupabaseAdmin();

  let canalIds: string[];
  if (canalId) {
    const { data: canal } = await sb
      .from("canais")
      .select("id")
      .eq("id", canalId)
      .eq("corretora_id" as never, corretoraId as never)
      .maybeSingle();
    if (!canal) {
      logger.warn("[estilo] canal não pertence à corretora; nada a colher", { canalId });
      return [];
    }
    canalIds = [canalId];
  } else {
    const { data: canais, error } = await sb
      .from("canais")
      .select("id")
      .eq("corretora_id" as never, corretoraId as never);
    if (error) throw new Error(`coletarAmostras(canais): ${error.message}`);
    canalIds = (canais ?? []).map((c) => (c as { id: string }).id);
  }
  if (canalIds.length === 0) return [];

  const { data, error } = await sb
    .from("operador_estilo_corpus")
    .select("corpo")
    .in("canal_id", canalIds)
    .order("criado_em", { ascending: false })
    .limit(limite);
  if (error) throw new Error(`coletarAmostras(corpus): ${error.message}`);

  return normalizarAmostras((data ?? []).map((m) => (m as { corpo: string | null }).corpo ?? ""));
}

// ----------------------------------------------------------------------------
// Parse de EXPORT do WhatsApp (texto colado / .txt)
// ----------------------------------------------------------------------------
// Formatos comuns:
//   Android: "12/06/2026 14:32 - João Corretor: mensagem"
//   iOS:     "[12/06/2026, 14:32:11] João Corretor: mensagem"
// Linhas seguintes sem cabeçalho = continuação da mensagem anterior.
// Cabeçalho "iOS"/colchetes: "[11:07, 08/06/2026] Nome: msg" OU "[08/06/2026, 11:07:33] Nome: msg"
// (data e hora em QUALQUER ordem dentro dos colchetes — varia por locale/SO).
const RE_BRACKET = /^\[([^\]]{6,40})\]\s*([^:]{1,60}?):\s(.*)$/;
// Cabeçalho "Android": "08/06/2026 11:07 - Nome: msg" (data hora - Nome:).
const RE_DASH =
  /^(\d{1,2}\/\d{1,2}\/\d{2,4}[,]?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp][Mm])?)\s*[-–]\s*([^:]{1,60}?):\s(.*)$/;
const RE_TEM_DATA = /\d{1,2}\/\d{1,2}\/\d{2,4}/;
const RE_TEM_HORA = /\d{1,2}:\d{2}/;

/** Extrai (remetente, corpo) de uma linha de export, nos dois formatos. null se não casar. */
function casarLinhaExport(linha: string): { remetente: string; corpo: string } | null {
  const mb = RE_BRACKET.exec(linha);
  if (mb && RE_TEM_DATA.test(mb[1] ?? "") && RE_TEM_HORA.test(mb[1] ?? "")) {
    return { remetente: (mb[2] ?? "").trim(), corpo: (mb[3] ?? "").trim() };
  }
  const md = RE_DASH.exec(linha);
  if (md) return { remetente: (md[2] ?? "").trim(), corpo: (md[3] ?? "").trim() };
  return null;
}

export interface ConversaParseada {
  remetentes: string[];
  porRemetente: Record<string, string[]>;
}

/**
 * Tenta interpretar o texto como export de conversa do WhatsApp. Devolve null se
 * não houver linhas no formato (texto avulso colado) — o chamador então trata tudo
 * como amostra única. Agrega continuação multilinha ao remetente da última linha.
 */
export function parseConversa(texto: string): ConversaParseada | null {
  const linhas = (texto ?? "").split(/\r?\n/).slice(0, MAX_LINHAS_FONTE);
  const porRemetente: Record<string, string[]> = {};
  const ordem: string[] = [];
  let atual: string | null = null;
  let casou = 0;

  for (const linha of linhas) {
    const m = casarLinhaExport(linha);
    if (m) {
      casou++;
      const { remetente, corpo } = m;
      if (!remetente) continue;
      let arr = porRemetente[remetente];
      if (!arr) {
        arr = [];
        porRemetente[remetente] = arr;
        if (ordem.length < MAX_REMETENTES) ordem.push(remetente);
      }
      if (corpo) arr.push(corpo);
      atual = remetente;
    } else if (atual && linha.trim()) {
      // continuação multilinha da última mensagem
      porRemetente[atual]?.push(linha.trim());
    }
  }

  // Heurística: só consideramos "export" se houver um número mínimo de linhas
  // casadas (evita falso-positivo de um texto avulso com "Algo: ...").
  if (casou < 2) return null;
  return { remetentes: ordem, porRemetente };
}

/** Quebra texto avulso em linhas, descarta vazios/curtos e redige PII. */
export function sanitizarTextoColado(texto: string): string[] {
  if (typeof texto !== "string") return [];
  const linhas = texto.split(/\r?\n/).slice(0, MAX_LINHAS_FONTE);
  return normalizarAmostras(linhas);
}

/**
 * Decodifica o .txt (base64). Rejeita binário (byte nulo) e arquivos acima do teto.
 * Devolve o texto cru (o chamador decide parsear como export ou tratar avulso).
 */
export function decodificarTxt(arquivoBase64: string): string | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(arquivoBase64, "base64");
  } catch {
    return null;
  }
  if (buf.length === 0 || buf.length > MAX_BYTES_FONTE) return null;
  if (buf.includes(0)) {
    logger.warn("[estilo] arquivo rejeitado (parece binário)");
    return null;
  }
  return buf.toString("utf8");
}

/** Pipeline comum: trim, descarta vazios/curtos, trunca corpo, redige PII, dedup. */
function normalizarAmostras(brutas: string[]): string[] {
  const vistas = new Set<string>();
  const out: string[] = [];
  for (const b of brutas) {
    const limpa = redigirPII((b ?? "").trim()).slice(0, MAX_CORPO_AMOSTRA).trim();
    if (limpa.length < MIN_CORPO) continue;
    if (vistas.has(limpa)) continue;
    vistas.add(limpa);
    out.push(limpa);
  }
  return out;
}

/**
 * Resolve as amostras de uma fonte textual (texto colado ou .txt já decodificado),
 * tratando export do WhatsApp. Pode devolver `precisaRemetente` quando há vários
 * remetentes e nenhum foi escolhido.
 */
function amostrasDeTexto(
  texto: string,
  remetenteOperador?: string,
): { amostras: string[]; precisaRemetente?: boolean; remetentes?: string[] } {
  const parsed = parseConversa(texto);
  if (!parsed) {
    // Texto avulso: trata tudo como amostra (sem identificação de lado).
    return { amostras: sanitizarTextoColado(texto) };
  }
  if (parsed.remetentes.length === 0) return { amostras: [] };
  if (parsed.remetentes.length === 1) {
    const unico = parsed.remetentes[0]!;
    return { amostras: normalizarAmostras(parsed.porRemetente[unico] ?? []) };
  }
  // Vários remetentes: precisa saber quem é o operador.
  if (!remetenteOperador) {
    return { amostras: [], precisaRemetente: true, remetentes: parsed.remetentes };
  }
  const linhas = parsed.porRemetente[remetenteOperador] ?? [];
  return { amostras: normalizarAmostras(linhas), remetentes: parsed.remetentes };
}

// ----------------------------------------------------------------------------
// Orquestração: coleta → destila → texto pronto para o campo (preview)
// ----------------------------------------------------------------------------
/**
 * Gera a amostra de estilo a partir da fonte escolhida. Não persiste nada.
 * Export com vários remetentes e sem escolha → { precisaRemetente, remetentes }.
 * Sem amostras → { amostra:"", nLinhasFonte:0 } (não lança). Claude indisponível
 * → lança Error (a rota traduz para 502).
 */
export async function gerarEstilo(input: GerarEstiloInput): Promise<GerarEstiloResult> {
  let amostras: string[];
  let precisaRemetente: boolean | undefined;
  let remetentes: string[] | undefined;

  switch (input.fonte) {
    case "linha":
      amostras = await coletarAmostrasDaLinha(input.corretoraId, input.canalId ?? null);
      break;
    case "texto": {
      const r = amostrasDeTexto(input.texto ?? "", input.remetenteOperador);
      amostras = r.amostras;
      precisaRemetente = r.precisaRemetente;
      remetentes = r.remetentes;
      break;
    }
    case "arquivo": {
      const txt = decodificarTxt(input.arquivoBase64 ?? "");
      if (txt === null) {
        amostras = [];
        break;
      }
      const r = amostrasDeTexto(txt, input.remetenteOperador);
      amostras = r.amostras;
      precisaRemetente = r.precisaRemetente;
      remetentes = r.remetentes;
      break;
    }
    default:
      amostras = [];
  }

  if (precisaRemetente) return { amostra: "", nLinhasFonte: 0, precisaRemetente: true, remetentes };

  const nLinhasFonte = amostras.length;
  if (nLinhasFonte === 0) return { amostra: "", nLinhasFonte: 0 };

  const linhas = await destilarEstilo(amostras);
  if (linhas === null) throw new Error("destilacao_indisponivel");

  const amostra = linhas.join("\n").slice(0, MAX_CHARS_AMOSTRA).trim();
  return { amostra, nLinhasFonte };
}
