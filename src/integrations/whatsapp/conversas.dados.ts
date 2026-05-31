/**
 * Operações de dados de uma conversa acionadas pelo OPERADOR (não pelo bot):
 *   - editarDadosColetados: grava/edita campos manualmente no painel.
 *   - enfileirarCampoForcado: pede ao bot para perguntar um campo específico.
 *
 * Ambas validam a chave contra o ROTEIRO da categoria da conversa (não só a
 * whitelist global) e mantêm trilha de auditoria em `dados_bot`. Usadas pelas
 * rotas /api/wa/conversas/:id/*. service_role (getSupabaseAdmin).
 */
import { getRoteiro } from "../../lib/roteiros";
import { logger } from "../../utils/logger";
import { getSupabaseAdmin } from "./supabase";

/** Tamanho máximo de um valor editado manualmente (defensivo). */
const MAX_VALOR = 500;
/** Mantém só as N últimas edições/auditoria para não crescer sem limite. */
const MAX_AUDITORIA = 100;

function comoObjeto(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function comoArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export interface ConversaParaEdicao {
  id: string;
  categoria: string | null;
  operador_id: string | null;
  dados_coletados: Record<string, unknown>;
  dados_bot: Record<string, unknown>;
}

export async function carregarConversaParaEdicao(
  conversaId: string,
): Promise<ConversaParaEdicao | null> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("conversas")
    .select("id, categoria, operador_id, dados_coletados, dados_bot")
    .eq("id", conversaId)
    .maybeSingle();
  if (error) {
    logger.warn("[conversas.dados] carregar falhou", { conversaId, erro: error.message });
    return null;
  }
  if (!data) return null;
  const row = data as {
    id: string;
    categoria: string | null;
    operador_id: string | null;
    dados_coletados: unknown;
    dados_bot?: unknown;
  };
  return {
    id: row.id,
    categoria: row.categoria ?? null,
    operador_id: row.operador_id ?? null,
    dados_coletados: comoObjeto(row.dados_coletados),
    dados_bot: comoObjeto(row.dados_bot),
  };
}

/** Conjunto de chaves válidas para o roteiro da categoria da conversa. */
function chavesDoRoteiro(categoria: string | null): Set<string> {
  // getRoteiro aceita o ENUM do banco (seguro_novo, nao_renovado, etc.).
  const roteiro = getRoteiro(categoria as Parameters<typeof getRoteiro>[0]);
  return new Set((roteiro?.campos ?? []).map((c) => c.chave));
}

export type ResultadoEdicao =
  | { ok: true; atualizados: string[]; ignorados: string[]; dados: Record<string, unknown> }
  | { ok: false; erro: "categoria_sem_roteiro" | "nenhuma_chave_valida"; ignorados: string[] };

/**
 * Edita campos em conversas.dados_coletados. Valida cada chave contra o roteiro
 * da categoria; ignora as inválidas (retorna em `ignorados`). Trim + limite de
 * tamanho. Grava trilha em dados_bot.edicoes_manuais. Idempotente por natureza
 * (merge raso).
 */
export async function editarDadosColetados(input: {
  conversaId: string;
  campos: Record<string, string>;
  porEmail: string | undefined;
  agoraIso: string;
}): Promise<ResultadoEdicao> {
  const conversa = await carregarConversaParaEdicao(input.conversaId);
  if (!conversa) return { ok: false, erro: "categoria_sem_roteiro", ignorados: [] };

  const validas = chavesDoRoteiro(conversa.categoria);
  if (validas.size === 0) {
    return { ok: false, erro: "categoria_sem_roteiro", ignorados: Object.keys(input.campos) };
  }

  const patch: Record<string, string> = {};
  const ignorados: string[] = [];
  for (const [k, vBruto] of Object.entries(input.campos)) {
    if (!validas.has(k)) {
      ignorados.push(k);
      continue;
    }
    const v = typeof vBruto === "string" ? vBruto.trim().slice(0, MAX_VALOR) : "";
    patch[k] = v;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, erro: "nenhuma_chave_valida", ignorados };
  }

  const mergedDados = { ...conversa.dados_coletados, ...patch };

  // Trilha de auditoria (append, capada).
  const auditoria = comoArray((conversa.dados_bot as { edicoes_manuais?: unknown }).edicoes_manuais);
  for (const [chave, valor] of Object.entries(patch)) {
    auditoria.push({ chave, valor, por: input.porEmail ?? "?", em: input.agoraIso });
  }
  const mergedBot = {
    ...conversa.dados_bot,
    edicoes_manuais: auditoria.slice(-MAX_AUDITORIA),
  };

  const sb = getSupabaseAdmin();
  const { error } = await sb
    .from("conversas")
    .update({ dados_coletados: mergedDados, dados_bot: mergedBot })
    .eq("id", input.conversaId);
  if (error) {
    throw new Error(`editarDadosColetados/update: ${error.message}`);
  }

  return { ok: true, atualizados: Object.keys(patch), ignorados, dados: mergedDados };
}

/** Valida CPF: 11 dígitos + dígitos verificadores. Rejeita repetidos (000…00). */
export function cpfValido(bruto: string): boolean {
  const d = (bruto ?? "").replace(/\D/g, "");
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false; // todos iguais (placeholder)
  const dig = (fim: number): number => {
    let soma = 0;
    for (let i = 0; i < fim; i++) soma += Number(d[i]) * (fim + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dig(9) === Number(d[9]) && dig(10) === Number(d[10]);
}

/** Formata 11 dígitos como 000.000.000-00. */
export function formatarCpf(bruto: string): string {
  const d = (bruto ?? "").replace(/\D/g, "");
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9, 11)}`;
}

export type ResultadoCpf =
  | { ok: true; cpf: string }
  | { ok: false; erro: "cpf_invalido" | "cliente_nao_encontrado" };

/**
 * Atualiza o CPF do CADASTRO do cliente (clientes.cpf) — fonte primária usada
 * pela cotação (mapearParaCotacao lê cliente.cpf antes de dados_coletados).
 * Valida o CPF (dígitos verificadores) e grava formatado. service_role.
 */
export async function editarCpfCliente(input: {
  conversaId: string;
  cpf: string;
  porEmail: string | undefined;
}): Promise<ResultadoCpf> {
  if (!cpfValido(input.cpf)) return { ok: false, erro: "cpf_invalido" };
  const sb = getSupabaseAdmin();
  const { data: conv } = await sb
    .from("conversas")
    .select("cliente_id")
    .eq("id", input.conversaId)
    .maybeSingle();
  const clienteId = (conv as { cliente_id?: string } | null)?.cliente_id;
  if (!clienteId) return { ok: false, erro: "cliente_nao_encontrado" };
  const cpf = formatarCpf(input.cpf);
  const { error } = await sb.from("clientes").update({ cpf }).eq("id", clienteId);
  if (error) throw new Error(`editarCpfCliente/update: ${error.message}`);
  logger.info("[conversas.dados] CPF do cliente atualizado", {
    conversaId: input.conversaId,
    por: input.porEmail ?? "?",
  });
  return { ok: true, cpf };
}

export type ResultadoFila =
  | { ok: true; fila: string[] }
  | { ok: false; erro: "chave_invalida" | "categoria_sem_roteiro" };

/**
 * Enfileira um campo para o bot perguntar ao cliente no próximo turno.
 * Persiste em dados_bot.campos_forcados (array de chaves, sem duplicar). NÃO
 * dispara mensagem ativa — a pergunta entra quando o cliente escrever de novo
 * (evita outbound não solicitado / risco de ban).
 */
export async function enfileirarCampoForcado(input: {
  conversaId: string;
  chave: string;
  porEmail: string | undefined;
  agoraIso: string;
}): Promise<ResultadoFila> {
  const conversa = await carregarConversaParaEdicao(input.conversaId);
  if (!conversa) return { ok: false, erro: "categoria_sem_roteiro" };

  const validas = chavesDoRoteiro(conversa.categoria);
  if (validas.size === 0) return { ok: false, erro: "categoria_sem_roteiro" };
  if (!validas.has(input.chave)) return { ok: false, erro: "chave_invalida" };

  const filaAtual = comoArray(
    (conversa.dados_bot as { campos_forcados?: unknown }).campos_forcados,
  ).filter((c): c is string => typeof c === "string");
  if (filaAtual.includes(input.chave)) {
    return { ok: true, fila: filaAtual }; // idempotente
  }
  const fila = [...filaAtual, input.chave];

  // Auditoria leve do pedido.
  const pedidos = comoArray((conversa.dados_bot as { pedidos_campo?: unknown }).pedidos_campo);
  pedidos.push({ chave: input.chave, por: input.porEmail ?? "?", em: input.agoraIso });

  const mergedBot = {
    ...conversa.dados_bot,
    campos_forcados: fila,
    pedidos_campo: pedidos.slice(-MAX_AUDITORIA),
  };

  const sb = getSupabaseAdmin();
  const { error } = await sb
    .from("conversas")
    .update({ dados_bot: mergedBot })
    .eq("id", input.conversaId);
  if (error) {
    throw new Error(`enfileirarCampoForcado/update: ${error.message}`);
  }
  return { ok: true, fila };
}
