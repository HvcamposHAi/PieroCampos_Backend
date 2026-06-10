/**
 * Queries de BI do Copiloto — TODAS read-only e TODAS escopadas por `corretoraId`.
 *
 * Regras invioláveis (auditáveis):
 *   - `corretoraId` é parâmetro de TODA função e entra em TODO `.eq('corretora_id', …)`.
 *     Ele vem da identidade do gestor (número autenticado), nunca do modelo/texto.
 *   - Nenhuma escrita: só `.select(...)`. Nada de insert/update/delete/upsert aqui.
 *   - Apólice NÃO tem coluna `status`: o status é DERIVADO da vigência (datas).
 *   - Totais monetários são somados AQUI (servidor), não pelo LLM.
 *
 * Tamanho de carteira assumido síncrono (milhares, não milhões) — ver premissa A4
 * do plano. Acima disso, paginar/materializar.
 */
import { getSupabaseAdmin } from "../../integrations/whatsapp/supabase";
import { BUCKET_APOLICES } from "../../integrations/apolice/apolice-storage";
import { logger } from "../../utils/logger";

export type StatusVigencia = "vigente" | "proxima_vencer" | "vencida";

/** YYYY-MM-DD de hoje (data local do servidor). */
function hojeIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** YYYY-MM-DD de hoje + N dias. */
function isoMaisDias(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Deriva o status de uma apólice a partir das datas de vigência. */
export function statusVigencia(fimVigencia: string | null, hoje = hojeIso(), janelaDias = 30): StatusVigencia {
  if (!fimVigencia) return "vigente";
  if (fimVigencia < hoje) return "vencida";
  const limite = new Date(hoje);
  limite.setDate(limite.getDate() + janelaDias);
  if (fimVigencia <= limite.toISOString().slice(0, 10)) return "proxima_vencer";
  return "vigente";
}

/** Sanitiza um termo de busca para uso seguro em filtros `.or()` do PostgREST. */
function termoSeguro(bruto: string): string {
  return (bruto ?? "").replace(/[,()%*]/g, " ").trim().slice(0, 60);
}

export interface ClienteResumo {
  id: string;
  nome: string | null;
  cpf: string | null;
  telefone: string | null;
}

/**
 * Busca clientes da corretora por nome (parcial), CPF ou telefone (dígitos).
 * Limitado (default 8) para caber numa resposta de chat.
 */
export async function buscarClientes(
  corretoraId: string,
  termo: string,
  limite = 8,
): Promise<ClienteResumo[]> {
  const t = termoSeguro(termo);
  if (!t) return [];
  const sb = getSupabaseAdmin();
  const dig = t.replace(/\D/g, "");
  const ors = [`nome.ilike.%${t}%`];
  if (dig) {
    ors.push(`cpf.ilike.%${dig}%`, `telefone.ilike.%${dig}%`);
  }
  const { data, error } = await sb
    .from("clientes")
    .select("id, nome, cpf, telefone")
    .eq("corretora_id", corretoraId)
    .is("deletado_em", null)
    .or(ors.join(","))
    .limit(limite);
  if (error) {
    logger.warn("[gestor.bi] buscarClientes falhou", { erro: error.message });
    return [];
  }
  return (data ?? []) as ClienteResumo[];
}

export interface ApoliceResumo {
  id: string;
  numero_apolice: string;
  ramo: string;
  seguradora: string;
  premio_total: number | null;
  inicio_vigencia: string;
  fim_vigencia: string;
  status: StatusVigencia;
  tem_pdf: boolean;
}

/**
 * Apólices de um cliente DENTRO da corretora. O filtro duplo (cliente_id +
 * corretora_id) é a defesa contra IDOR: um clienteId de outra corretora não casa.
 */
export async function apolicesDoCliente(
  corretoraId: string,
  clienteId: string,
): Promise<ApoliceResumo[]> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("apolices")
    .select("id, numero_apolice, ramo, seguradora, premio_total, inicio_vigencia, fim_vigencia, pdf_url")
    .eq("corretora_id", corretoraId)
    .eq("cliente_id", clienteId)
    .is("deletado_em", null)
    .order("fim_vigencia", { ascending: false });
  if (error) {
    logger.warn("[gestor.bi] apolicesDoCliente falhou", { erro: error.message });
    return [];
  }
  const hoje = hojeIso();
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    numero_apolice: String(r.numero_apolice ?? ""),
    ramo: String(r.ramo ?? ""),
    seguradora: String(r.seguradora ?? ""),
    premio_total: (r.premio_total as number | null) ?? null,
    inicio_vigencia: String(r.inicio_vigencia ?? ""),
    fim_vigencia: String(r.fim_vigencia ?? ""),
    status: statusVigencia((r.fim_vigencia as string | null) ?? null, hoje),
    tem_pdf: Boolean(r.pdf_url),
  }));
}

export interface ApoliceAVencer extends ApoliceResumo {
  cliente_id: string;
  cliente_nome: string | null;
}

/**
 * Apólices com fim de vigência entre hoje e hoje+N dias (default 30), na corretora.
 * Inclui o nome do cliente (embed) para a resposta ficar útil sem outra consulta.
 */
export async function apolicesAVencer(corretoraId: string, dias = 30): Promise<ApoliceAVencer[]> {
  const sb = getSupabaseAdmin();
  const hoje = hojeIso();
  const limite = isoMaisDias(dias);
  const { data, error } = await sb
    .from("apolices")
    .select(
      "id, cliente_id, numero_apolice, ramo, seguradora, premio_total, inicio_vigencia, fim_vigencia, pdf_url, clientes(nome)",
    )
    .eq("corretora_id", corretoraId)
    .is("deletado_em", null)
    .gte("fim_vigencia", hoje)
    .lte("fim_vigencia", limite)
    .order("fim_vigencia", { ascending: true })
    .limit(50);
  if (error) {
    logger.warn("[gestor.bi] apolicesAVencer falhou", { erro: error.message });
    return [];
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const cli = r.clientes as { nome?: string | null } | null;
    return {
      id: String(r.id),
      cliente_id: String(r.cliente_id),
      cliente_nome: cli?.nome ?? null,
      numero_apolice: String(r.numero_apolice ?? ""),
      ramo: String(r.ramo ?? ""),
      seguradora: String(r.seguradora ?? ""),
      premio_total: (r.premio_total as number | null) ?? null,
      inicio_vigencia: String(r.inicio_vigencia ?? ""),
      fim_vigencia: String(r.fim_vigencia ?? ""),
      status: "proxima_vencer" as const,
      tem_pdf: Boolean(r.pdf_url),
    };
  });
}

export interface ResumoCarteira {
  total_apolices: number;
  premio_total: number;
  vigentes: number;
  proximas_vencer_30d: number;
  vencidas: number;
  por_ramo: Array<{ ramo: string; quantidade: number; premio_total: number }>;
  por_seguradora: Array<{ seguradora: string; quantidade: number; premio_total: number }>;
  computado_em: string;
}

/**
 * Agrega a carteira da corretora: contagens e prêmio por ramo/seguradora/status.
 * Soma feita no servidor (não no LLM). Carimba `computado_em` p/ a resposta citar.
 */
export async function resumoCarteira(corretoraId: string): Promise<ResumoCarteira> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("apolices")
    .select("ramo, seguradora, premio_total, fim_vigencia")
    .eq("corretora_id", corretoraId)
    .is("deletado_em", null);
  const vazio: ResumoCarteira = {
    total_apolices: 0,
    premio_total: 0,
    vigentes: 0,
    proximas_vencer_30d: 0,
    vencidas: 0,
    por_ramo: [],
    por_seguradora: [],
    computado_em: new Date().toISOString(),
  };
  if (error) {
    logger.warn("[gestor.bi] resumoCarteira falhou", { erro: error.message });
    return vazio;
  }
  const hoje = hojeIso();
  const ramoMap = new Map<string, { quantidade: number; premio_total: number }>();
  const segMap = new Map<string, { quantidade: number; premio_total: number }>();
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const premio = (r.premio_total as number | null) ?? 0;
    const ramo = String(r.ramo ?? "—");
    const seg = String(r.seguradora ?? "—");
    vazio.total_apolices += 1;
    vazio.premio_total += premio;
    const st = statusVigencia((r.fim_vigencia as string | null) ?? null, hoje);
    if (st === "vigente") vazio.vigentes += 1;
    else if (st === "proxima_vencer") vazio.proximas_vencer_30d += 1;
    else vazio.vencidas += 1;
    const ra = ramoMap.get(ramo) ?? { quantidade: 0, premio_total: 0 };
    ra.quantidade += 1;
    ra.premio_total += premio;
    ramoMap.set(ramo, ra);
    const se = segMap.get(seg) ?? { quantidade: 0, premio_total: 0 };
    se.quantidade += 1;
    se.premio_total += premio;
    segMap.set(seg, se);
  }
  vazio.por_ramo = [...ramoMap.entries()]
    .map(([ramo, v]) => ({ ramo, ...v }))
    .sort((a, b) => b.premio_total - a.premio_total);
  vazio.por_seguradora = [...segMap.entries()]
    .map(([seguradora, v]) => ({ seguradora, ...v }))
    .sort((a, b) => b.premio_total - a.premio_total);
  return vazio;
}

export interface FunilResumo {
  cotacoes_por_status: Record<string, number>;
  propostas_por_status: Record<string, number>;
  computado_em: string;
}

/** Conta cotações e propostas por status, na corretora. Agregação em código. */
export async function funilResumo(corretoraId: string): Promise<FunilResumo> {
  const sb = getSupabaseAdmin();
  const out: FunilResumo = {
    cotacoes_por_status: {},
    propostas_por_status: {},
    computado_em: new Date().toISOString(),
  };
  const [cot, prop] = await Promise.all([
    sb.from("cotacoes").select("status").eq("corretora_id", corretoraId),
    sb.from("propostas").select("status").eq("corretora_id", corretoraId).is("deletado_em", null),
  ]);
  if (cot.error) logger.warn("[gestor.bi] funil cotacoes falhou", { erro: cot.error.message });
  if (prop.error) logger.warn("[gestor.bi] funil propostas falhou", { erro: prop.error.message });
  for (const r of (cot.data ?? []) as Array<{ status?: string }>) {
    const s = r.status ?? "—";
    out.cotacoes_por_status[s] = (out.cotacoes_por_status[s] ?? 0) + 1;
  }
  for (const r of (prop.data ?? []) as Array<{ status?: string }>) {
    const s = r.status ?? "—";
    out.propostas_por_status[s] = (out.propostas_por_status[s] ?? 0) + 1;
  }
  return out;
}

export interface PdfApolice {
  buffer: Buffer;
  fileName: string;
  numeroApolice: string;
}

/**
 * Baixa o PDF de UMA apólice da corretora a partir do bucket privado `apolices`.
 * Defesa IDOR: a apólice é lida com `.eq('corretora_id', corretoraId)` ANTES de
 * qualquer download — um apoliceId de outra corretora não casa e retorna null.
 * Best-effort: sem pdf_url / erro de storage → null (o serviço avisa "indisponível").
 */
export async function pdfApolice(corretoraId: string, apoliceId: string): Promise<PdfApolice | null> {
  if (!corretoraId || !apoliceId) return null;
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("apolices")
    .select("id, numero_apolice, pdf_url")
    .eq("corretora_id", corretoraId)
    .eq("id", apoliceId)
    .is("deletado_em", null)
    .maybeSingle();
  if (error) {
    logger.warn("[gestor.bi] pdfApolice lookup falhou", { erro: error.message });
    return null;
  }
  const row = data as { numero_apolice?: string | null; pdf_url?: string | null } | null;
  if (!row?.pdf_url) return null;
  try {
    const { data: blob, error: errDl } = await sb.storage.from(BUCKET_APOLICES).download(row.pdf_url);
    if (errDl || !blob) {
      logger.warn("[gestor.bi] pdfApolice download falhou", { erro: errDl?.message });
      return null;
    }
    const buffer = Buffer.from(await blob.arrayBuffer());
    const numero = String(row.numero_apolice ?? apoliceId);
    return { buffer, fileName: `apolice-${numero}.pdf`, numeroApolice: numero };
  } catch (e) {
    logger.warn("[gestor.bi] pdfApolice exceção no download", { erro: (e as Error).message });
    return null;
  }
}
