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
import { cpfValido, formatarCpf } from "../../lib/cpf";
import { normalizarTelefoneBr } from "../../lib/telefone";
import { logger } from "../../utils/logger";
import { getSupabaseAdmin } from "./supabase";

// Reexport p/ compatibilidade com imports existentes (ex.: test/cpf.test.ts).
export { cpfValido, formatarCpf };

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

export interface ConversaParaEnvio {
  id: string;
  estado: string;
  operador_id: string | null;
  canal_id: string | null;
  telefone: string | null;
  /** JID autêntico capturado no inbound (endereço entregável). Preferido sobre o telefone. */
  wa_jid: string | null;
}

/**
 * Carrega o mínimo para um envio do OPERADOR: estado (precisa estar
 * `humano_assumiu`), dono atual e o destino (canal + telefone do cliente, do
 * qual derivamos o JID Baileys). service_role. Retorna null se a conversa não
 * existir.
 */
export async function carregarConversaParaEnvio(
  conversaId: string,
): Promise<ConversaParaEnvio | null> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("conversas")
    .select("id, estado, operador_id, canal_id, wa_jid, clientes(telefone)")
    .eq("id", conversaId)
    .maybeSingle();
  if (error) {
    logger.warn("[conversas.dados] carregar p/ envio falhou", {
      conversaId,
      erro: error.message,
    });
    return null;
  }
  if (!data) return null;
  const row = data as {
    id: string;
    estado: string;
    operador_id: string | null;
    canal_id: string | null;
    wa_jid: string | null;
    clientes: { telefone: string | null } | { telefone: string | null }[] | null;
  };
  // PostgREST devolve o join 1:1 como objeto, mas tipamos defensivamente p/ array.
  const cliente = Array.isArray(row.clientes) ? row.clientes[0] : row.clientes;
  return {
    id: row.id,
    estado: row.estado,
    operador_id: row.operador_id ?? null,
    canal_id: row.canal_id ?? null,
    telefone: cliente?.telefone ?? null,
    wa_jid: row.wa_jid ?? null,
  };
}

/** Persiste o JID resolvido (via onWhatsApp) na conversa, para cache e reuso. */
export async function gravarWaJid(conversaId: string, waJid: string): Promise<void> {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("conversas").update({ wa_jid: waJid }).eq("id", conversaId);
  if (error) throw new Error(`gravarWaJid/update: ${error.message}`);
}

/**
 * Transiciona o estado de atendimento de uma conversa (assumir/devolver) e
 * opcionalmente grava o dono. Semântica de `operadorId`:
 *   - undefined (omitido) → não toca em operador_id;
 *   - string              → assumir: grava o dono;
 *   - null                → devolver: LIMPA o dono (coerência na Fila).
 * service_role.
 */
export async function definirEstadoConversa(input: {
  conversaId: string;
  estado: "humano_assumiu" | "bot_ativo";
  operadorId?: string | null;
}): Promise<void> {
  const sb = getSupabaseAdmin();
  const patch: { estado: string; operador_id?: string | null } = { estado: input.estado };
  if (input.operadorId !== undefined) patch.operador_id = input.operadorId; // string OU null
  const { error } = await sb.from("conversas").update(patch).eq("id", input.conversaId);
  if (error) throw new Error(`definirEstadoConversa/update: ${error.message}`);
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
    if (k === "cpf") {
      // CPF: não grava inválido (vai p/ ignorados) e sempre formatado.
      if (!cpfValido(v)) {
        ignorados.push("cpf");
        continue;
      }
      patch[k] = formatarCpf(v);
      continue;
    }
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

  // CPF é fonte única: ao editar em Dados, sincroniza o cadastro (clientes.cpf).
  if (patch.cpf) await sincronizarCpfCadastro(input.conversaId, patch.cpf);

  return { ok: true, atualizados: Object.keys(patch), ignorados, dados: mergedDados };
}

/** Espelha o CPF no cadastro (clientes.cpf) a partir da conversa. Best-effort. */
async function sincronizarCpfCadastro(conversaId: string, cpf: string): Promise<void> {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("conversas").select("cliente_id").eq("id", conversaId).maybeSingle();
  const clienteId = (data as { cliente_id?: string } | null)?.cliente_id;
  if (!clienteId) return;
  const { error } = await sb.from("clientes").update({ cpf }).eq("id", clienteId);
  if (error) logger.warn("[conversas.dados] sync cpf→cadastro falhou", { conversaId, erro: error.message });
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
    .select("cliente_id, dados_coletados")
    .eq("id", input.conversaId)
    .maybeSingle();
  const row = conv as { cliente_id?: string; dados_coletados?: unknown } | null;
  const clienteId = row?.cliente_id;
  if (!clienteId) return { ok: false, erro: "cliente_nao_encontrado" };
  const cpf = formatarCpf(input.cpf);
  const { error } = await sb.from("clientes").update({ cpf }).eq("id", clienteId);
  if (error) throw new Error(`editarCpfCliente/update: ${error.message}`);
  // Fonte única: espelha também em dados_coletados.cpf (que a cotação lê).
  const dados = comoObjeto(row?.dados_coletados);
  const { error: e2 } = await sb
    .from("conversas")
    .update({ dados_coletados: { ...dados, cpf } })
    .eq("id", input.conversaId);
  if (e2) logger.warn("[conversas.dados] sync cpf→coletados falhou", { conversaId: input.conversaId, erro: e2.message });
  logger.info("[conversas.dados] CPF do cliente atualizado", {
    conversaId: input.conversaId,
    por: input.porEmail ?? "?",
  });
  return { ok: true, cpf };
}

export type ResultadoTelefone =
  | { ok: true; telefone: string }
  | { ok: false; erro: "telefone_invalido" | "cliente_nao_encontrado" };

/**
 * Atualiza o TELEFONE do cadastro (clientes.telefone) — edição manual do operador
 * quando o número veio errado (ex.: contato @lid). Valida/normaliza BR para E.164.
 * NÃO altera o `conversas.wa_jid` (esse é o endereço de envio, autêntico).
 */
export async function editarTelefoneCliente(input: {
  conversaId: string;
  telefone: string;
  porEmail: string | undefined;
}): Promise<ResultadoTelefone> {
  const tel = normalizarTelefoneBr(input.telefone);
  if (!tel) return { ok: false, erro: "telefone_invalido" };
  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("conversas")
    .select("cliente_id")
    .eq("id", input.conversaId)
    .maybeSingle();
  const clienteId = (data as { cliente_id?: string } | null)?.cliente_id;
  if (!clienteId) return { ok: false, erro: "cliente_nao_encontrado" };
  const { error } = await sb.from("clientes").update({ telefone: tel }).eq("id", clienteId);
  if (error) throw new Error(`editarTelefoneCliente/update: ${error.message}`);
  logger.info("[conversas.dados] telefone do cliente atualizado", {
    conversaId: input.conversaId,
    por: input.porEmail ?? "?",
  });
  return { ok: true, telefone: tel };
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
