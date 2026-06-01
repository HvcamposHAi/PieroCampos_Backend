/**
 * Persistência do módulo WhatsApp no Supabase.
 *
 * Responsabilidades:
 *   - Atualizar `canais` (status, qr_code, numero_e164, ...) durante o lifecycle.
 *   - Resolver/criar `clientes` por telefone (1ª interação cria a row).
 *   - Resolver/criar `conversas` por (canal, cliente, não encerrada).
 *   - Inserir mensagens em `mensagens` com idempotência por id Baileys.
 *
 * Tudo via service_role (bypassa RLS). Sem reentrância: cada função é uma
 * transação curta de 1–3 statements.
 */
import { logger } from "../../utils/logger";
import { getSupabaseAdmin } from "./supabase";
import type { CanalRow, CanalUpdate, ConversaRow, MensagemInsert } from "./wa.types";

/** Converte JID Baileys (`<num>@s.whatsapp.net`) para E.164 (`+<num>`). */
export function jidParaE164(jid: string): string | null {
  const semSufixo = jid.split("@")[0];
  if (!semSufixo) return null;
  // Baileys pode trazer device tag tipo "5541999998888:42". Removemos.
  const limpo = semSufixo.split(":")[0];
  if (!limpo || !/^\d+$/.test(limpo)) return null;
  return `+${limpo}`;
}

/**
 * Inverso de `jidParaE164`: converte um telefone E.164 (`+<num>`) no JID Baileys
 * de usuário (`<num>@s.whatsapp.net`). Aceita também o número sem `+`/com máscara
 * (só os dígitos importam). Retorna null se não restar dígito algum.
 */
export function e164ParaJid(telefone: string): string | null {
  const digitos = (telefone ?? "").replace(/\D/g, "");
  if (!digitos) return null;
  return `${digitos}@s.whatsapp.net`;
}

export async function atualizarCanal(canalId: string, update: CanalUpdate): Promise<void> {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("canais").update(update).eq("id", canalId);
  if (error) {
    logger.error("[wa.persistence] falha em atualizarCanal", {
      canalId,
      campos: Object.keys(update),
      erro: error.message,
    });
    throw error;
  }
}

export interface CanalParaBootstrap {
  id: string;
  apelido: string;
  numero_e164: string | null;
}

/** Lista canais com auth_state que devem ter o socket reaberto no boot. */
export async function lerCanaisParaBootstrap(): Promise<CanalParaBootstrap[]> {
  const sb = getSupabaseAdmin();
  // Pega canais Baileys ativos que têm row 'creds' em wa_auth_state.
  const { data, error } = await sb
    .from("canais")
    .select("id, apelido, numero_e164, wa_auth_state!inner(key)")
    .eq("provider", "baileys")
    .eq("ativo", true)
    .eq("wa_auth_state.key", "creds");
  if (error) throw error;
  return ((data ?? []) as Array<Pick<CanalRow, "id" | "apelido" | "numero_e164">>).map((r) => ({
    id: r.id,
    apelido: r.apelido,
    numero_e164: r.numero_e164,
  }));
}

export async function buscarCanal(canalId: string): Promise<CanalRow | null> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("canais")
    .select(
      "id, apelido, ativo, provider, status, numero_e164, numero_twilio, display_name, qr_code, qr_expires_at, last_connected_at, last_disconnect_reason",
    )
    .eq("id", canalId)
    .maybeSingle();
  if (error) throw error;
  return (data as CanalRow | null) ?? null;
}

/**
 * Garante uma row em `clientes` para o telefone informado. Sem UNIQUE em
 * telefone, fazemos read-then-write — race rara (1ª msg simultânea) é tolerável.
 */
async function obterOuCriarCliente(telefone: string, nome?: string | null): Promise<string> {
  const sb = getSupabaseAdmin();
  const { data: existente, error: errSel } = await sb
    .from("clientes")
    .select("id, nome")
    .eq("telefone", telefone)
    .maybeSingle();
  if (errSel) throw errSel;
  if (existente?.id) {
    // Atualiza nome se estava vazio e Baileys trouxe pushName.
    if (!existente.nome && nome) {
      await sb.from("clientes").update({ nome }).eq("id", existente.id);
    }
    return existente.id;
  }
  const { data: inserido, error: errIns } = await sb
    .from("clientes")
    .insert({ telefone, nome: nome ?? null })
    .select("id")
    .single();
  if (errIns) throw errIns;
  return inserido.id;
}

/** Acha uma conversa aberta (estado != 'encerrado') para (canal, cliente) ou cria. */
async function obterOuCriarConversaAberta(
  canalId: string,
  clienteId: string,
): Promise<ConversaRow> {
  const sb = getSupabaseAdmin();
  const { data: existente, error: errSel } = await sb
    .from("conversas")
    .select("id, canal_id, cliente_id, estado")
    .eq("canal_id", canalId)
    .eq("cliente_id", clienteId)
    .neq("estado", "encerrado")
    .order("criado_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (errSel) throw errSel;
  if (existente) return existente as ConversaRow;

  const { data: nova, error: errIns } = await sb
    .from("conversas")
    .insert({
      canal_id: canalId,
      cliente_id: clienteId,
      estado: "bot_ativo",
      categoria: "seguro_novo", // ENUM do banco; o adapter do front converte para CategoriaBot.
    })
    .select("id, canal_id, cliente_id, estado")
    .single();
  if (errIns) throw errIns;
  return nova as ConversaRow;
}

export interface MensagemEntradaInput {
  canalId: string;
  jidRemoto: string;
  texto: string;
  pushName?: string;
  providerMsgId?: string;
  enviadaEm?: Date;
}

export interface RegistroEntradaResultado {
  conversaId: string;
  clienteId: string;
  estado: string;
  /** true se a mensagem já estava persistida (id Baileys repetido) — handlers devem não reprocessar. */
  duplicada: boolean;
}

/**
 * Idempotente em `providerMsgId` (gravado em mensagens.twilio_message_sid — coluna que
 * será renomeada para provider_msg_id no futuro). Se o id já existe, retorna
 * `duplicada=true` para que o handler pule processamento subsequente (Bia).
 */
export async function registrarMensagemEntrada(
  input: MensagemEntradaInput,
): Promise<RegistroEntradaResultado | null> {
  const sb = getSupabaseAdmin();
  const telefone = jidParaE164(input.jidRemoto);
  if (!telefone) {
    logger.warn("[wa.persistence] jid sem telefone (ignorado)", { jid: input.jidRemoto });
    return null;
  }

  // Idempotência: se já gravamos esta mensagem, retorna apontando duplicada.
  if (input.providerMsgId) {
    const { data: ja } = await sb
      .from("mensagens")
      .select("id, conversa_id, conversas(cliente_id, estado)")
      .eq("twilio_message_sid", input.providerMsgId)
      .maybeSingle();
    if (ja) {
      const conv = (ja as unknown as {
        conversa_id: string;
        conversas?: { cliente_id: string; estado: string };
      }).conversas;
      return {
        conversaId: (ja as { conversa_id: string }).conversa_id,
        clienteId: conv?.cliente_id ?? "",
        estado: conv?.estado ?? "bot_ativo",
        duplicada: true,
      };
    }
  }

  const clienteId = await obterOuCriarCliente(telefone, input.pushName ?? null);
  const conversa = await obterOuCriarConversaAberta(input.canalId, clienteId);

  const msg: MensagemInsert = {
    conversa_id: conversa.id,
    direcao: "entrada",
    origem: "cliente",
    corpo: input.texto,
    twilio_message_sid: input.providerMsgId ?? null,
    enviada_em: (input.enviadaEm ?? new Date()).toISOString(),
  };

  const { error: errMsg } = await sb.from("mensagens").insert(msg);
  if (errMsg) throw errMsg;

  // Atualiza o cartão da fila com o timestamp da última mensagem E grava o JID
  // AUTÊNTICO que o cliente usou (input.jidRemoto). Esse é o endereço entregável
  // — reusado em TODO envio out-of-band (operador/IA/simular), evitando remontar
  // o jid a partir do telefone (que falha p/ 9º dígito BR e contas @lid).
  await sb
    .from("conversas")
    .update({ ultima_mensagem_em: msg.enviada_em, wa_jid: input.jidRemoto })
    .eq("id", conversa.id);

  return {
    conversaId: conversa.id,
    clienteId,
    estado: conversa.estado,
    duplicada: false,
  };
}

/**
 * Atualiza o status de ENTREGA de uma mensagem de saída a partir do ack do
 * Baileys (evento messages.update). `status` é o WAMessageStatus numérico
 * (2=enviado/server, 3=entregue, 4=lido, 5=reproduzido). Casa por
 * twilio_message_sid = key.id. Best-effort: não lança (chamado em loop de evento).
 * Só "avança" o status (não regride: lido não vira entregue).
 */
export async function registrarStatusEntrega(
  providerMsgId: string,
  status: number,
): Promise<void> {
  if (!providerMsgId || !Number.isFinite(status) || status < 2) return;
  const sb = getSupabaseAdmin();
  try {
    const { data } = await sb
      .from("mensagens")
      .select("id, status_entrega")
      .eq("twilio_message_sid", providerMsgId)
      .maybeSingle();
    const row = data as { id: string; status_entrega: number | null } | null;
    if (!row) return; // não é mensagem nossa (ou ainda não persistida)
    if ((row.status_entrega ?? 0) >= status) return; // não regride
    const patch: { status_entrega: number; entregue_em?: string } = { status_entrega: status };
    if (status >= 3) patch.entregue_em = new Date().toISOString();
    await sb.from("mensagens").update(patch).eq("id", row.id);
  } catch (e) {
    logger.warn("[wa.persistence] registrarStatusEntrega falhou", {
      providerMsgId,
      erro: (e as Error).message,
    });
  }
}

/**
 * Insere uma fala do cliente DIRETO numa conversa existente (origem='cliente',
 * direcao='entrada'), sem passar por obterOuCriarConversa — usado pelo endpoint
 * de SIMULAÇÃO (operador injeta a fala do cliente no fluxo real do bot). Não faz
 * dedup por providerMsgId (é manual, não vem do Baileys). service_role.
 */
export async function registrarMensagemEntradaManual(
  conversaId: string,
  texto: string,
): Promise<void> {
  const sb = getSupabaseAdmin();
  const enviadaEm = new Date().toISOString();
  const msg: MensagemInsert = {
    conversa_id: conversaId,
    direcao: "entrada",
    origem: "cliente",
    corpo: texto,
    enviada_em: enviadaEm,
  };
  const { error } = await sb.from("mensagens").insert(msg);
  if (error) throw error;
  await sb.from("conversas").update({ ultima_mensagem_em: enviadaEm }).eq("id", conversaId);
}

export interface MensagemSaidaInput {
  canalId: string;
  conversaId: string;
  texto: string;
  providerMsgId?: string;
  operadorNome?: string;
}

export async function registrarMensagemSaida(input: MensagemSaidaInput): Promise<void> {
  const sb = getSupabaseAdmin();
  const enviadaEm = new Date().toISOString();

  // Nota: a coluna `operador_nome` não existe em `mensagens` em prod; o nome do
  // operador fica em `conversas.operador_id` (via assumir conversa) e na UI.
  const msg: MensagemInsert = {
    conversa_id: input.conversaId,
    direcao: "saida",
    origem: "operador",
    corpo: input.texto,
    twilio_message_sid: input.providerMsgId ?? null,
    enviada_em: enviadaEm,
  };

  const { error: errMsg } = await sb.from("mensagens").insert(msg);
  if (errMsg) throw errMsg;

  await sb
    .from("conversas")
    .update({ ultima_mensagem_em: enviadaEm })
    .eq("id", input.conversaId);
}

export interface MensagemSaidaBotDocumentoInput {
  canalId: string;
  conversaId: string;
  /** Texto que aparece no card da fila (ex.: nome do arquivo / legenda). */
  descricao: string;
  /** Tipo de mídia (ex.: "document"). */
  midiaTipo: string;
  providerMsgId?: string;
}

/**
 * Variante para a Bia enviar um DOCUMENTO (ex.: questionário .xlsx). Grava
 * `origem='bot'`, `midia_tipo` e `corpo`=descrição. `midia_url` fica NULL
 * (enviamos o buffer em memória; sem upload p/ Storage nesta versão).
 */
export async function registrarMensagemSaidaBotDocumento(
  input: MensagemSaidaBotDocumentoInput,
): Promise<void> {
  const sb = getSupabaseAdmin();
  const enviadaEm = new Date().toISOString();

  const msg: MensagemInsert = {
    conversa_id: input.conversaId,
    direcao: "saida",
    origem: "bot",
    corpo: input.descricao,
    midia_url: null,
    midia_tipo: input.midiaTipo,
    twilio_message_sid: input.providerMsgId ?? null,
    enviada_em: enviadaEm,
  };

  const { error: errMsg } = await sb.from("mensagens").insert(msg);
  if (errMsg) throw errMsg;

  await sb
    .from("conversas")
    .update({ ultima_mensagem_em: enviadaEm })
    .eq("id", input.conversaId);
}

export interface MensagemSaidaBotInput {
  canalId: string;
  conversaId: string;
  texto: string;
  providerMsgId?: string;
}

/**
 * Variante para a Bia: `origem='bot'`, sem operador_nome. A `resumo_ultima_mensagem`
 * é prefixada com "Bia: " para o card da fila ficar inteligível mesmo sem abrir.
 */
export async function registrarMensagemSaidaBot(input: MensagemSaidaBotInput): Promise<void> {
  const sb = getSupabaseAdmin();
  const enviadaEm = new Date().toISOString();

  const msg: MensagemInsert = {
    conversa_id: input.conversaId,
    direcao: "saida",
    origem: "bot",
    corpo: input.texto,
    twilio_message_sid: input.providerMsgId ?? null,
    enviada_em: enviadaEm,
  };

  const { error: errMsg } = await sb.from("mensagens").insert(msg);
  if (errMsg) throw errMsg;

  await sb
    .from("conversas")
    .update({ ultima_mensagem_em: enviadaEm })
    .eq("id", input.conversaId);
}
