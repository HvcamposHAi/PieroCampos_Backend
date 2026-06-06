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
import { getRoteiro, type CategoriaConversa } from "../../lib/roteiros";
import { CORRETORA_SEED_ID } from "../persistence/supabase-persistence";
import type { CanalRow, CanalUpdate, ConversaRow, MensagemInsert } from "./wa.types";

/**
 * Tenant de um canal (corretora dona + ramo padrão da linha). É o ÚNICO ponto de
 * verdade do tenant no caminho INBOUND (mensagem chega sem usuário/JWT): tudo que
 * for criado a partir de uma mensagem herda daqui. Cacheado por canal (canais
 * mudam raramente); fail-safe = corretora seed / ramo auto (nunca cria órfão).
 */
interface CanalTenant {
  corretoraId: string;
  ramoPadrao: string | null;
}
const tenantCanalCache = new Map<string, CanalTenant>();

export async function lerTenantDoCanal(canalId: string): Promise<CanalTenant> {
  const cache = tenantCanalCache.get(canalId);
  if (cache) return cache;
  const sb = getSupabaseAdmin();
  try {
    const { data } = await sb
      .from("canais")
      .select("corretora_id, ramo_padrao" as never)
      .eq("id", canalId)
      .maybeSingle();
    const row = (data as { corretora_id?: string | null; ramo_padrao?: string | null } | null) ?? null;
    const tenant: CanalTenant = {
      corretoraId: row?.corretora_id ?? CORRETORA_SEED_ID,
      ramoPadrao: row?.ramo_padrao ?? null,
    };
    tenantCanalCache.set(canalId, tenant);
    return tenant;
  } catch (e) {
    logger.warn("[wa.persistence] lerTenantDoCanal exceção; fail-safe seed/auto", {
      canalId,
      erro: (e as Error).message,
    });
    return { corretoraId: CORRETORA_SEED_ID, ramoPadrao: null };
  }
}

/** Limpa o cache de tenant de um canal (uso em testes / após alteração do canal). */
export function _resetTenantCanalCache(canalId?: string): void {
  if (canalId) tenantCanalCache.delete(canalId);
  else tenantCanalCache.clear();
}

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
      "id, apelido, ativo, bot_ativo, alerta_handoff_ativo, alerta_numero_e164, provider, status, numero_e164, numero_twilio, display_name, qr_code, qr_expires_at, last_connected_at, last_disconnect_reason",
    )
    .eq("id", canalId)
    .maybeSingle();
  if (error) throw error;
  return (data as CanalRow | null) ?? null;
}

/**
 * Lê a config do alerta de handoff da linha. FAIL-SAFE = DESLIGADO: qualquer
 * erro de leitura ou coluna ausente devolve `{ ativo: false }` — ao contrário de
 * `lerBotAtivoCanal` (fail-open), aqui o alerta é um efeito colateral opcional e
 * NUNCA deve disparar em dúvida nem bloquear o handoff. `numero` null/'' significa
 * "enviar para o próprio número da linha" (resolvido no sessionManager).
 */
export async function lerAlertaConfigCanal(
  canalId: string,
): Promise<{ ativo: boolean; numero: string | null }> {
  const desligado = { ativo: false, numero: null };
  if (!canalId) return desligado;
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("canais")
      .select("alerta_handoff_ativo, alerta_numero_e164")
      .eq("id", canalId)
      .maybeSingle();
    if (error) {
      logger.warn("[wa.persistence] lerAlertaConfigCanal falhou; fail-safe desligado", {
        canalId,
        erro: error.message,
      });
      return desligado;
    }
    const row = data as { alerta_handoff_ativo?: boolean | null; alerta_numero_e164?: string | null } | null;
    if (!row || row.alerta_handoff_ativo !== true) return desligado;
    const numero = (row.alerta_numero_e164 ?? "").trim();
    return { ativo: true, numero: numero || null };
  } catch (e) {
    logger.warn("[wa.persistence] lerAlertaConfigCanal exceção; fail-safe desligado", {
      canalId,
      erro: (e as Error).message,
    });
    return desligado;
  }
}

/**
 * Lê apenas o master switch da Bia para a linha (gate barato chamado a cada
 * mensagem). FAIL-OPEN: qualquer erro de leitura ou coluna ausente devolve
 * `true` — nunca calar a Bia por uma falha de infra. Só `bot_ativo === false`
 * explícito silencia a linha.
 */
export async function lerBotAtivoCanal(canalId: string): Promise<boolean> {
  if (!canalId) return true;
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("canais")
      .select("bot_ativo")
      .eq("id", canalId)
      .maybeSingle();
    if (error) {
      logger.warn("[wa.persistence] lerBotAtivoCanal falhou; fail-open", {
        canalId,
        erro: error.message,
      });
      return true;
    }
    const v = (data as { bot_ativo?: boolean | null } | null)?.bot_ativo;
    return v === false ? false : true;
  } catch (e) {
    logger.warn("[wa.persistence] lerBotAtivoCanal exceção; fail-open", {
      canalId,
      erro: (e as Error).message,
    });
    return true;
  }
}

/**
 * Garante uma row em `clientes` para o telefone informado DENTRO da corretora.
 * Isolamento de tenant: o MESMO telefone em duas corretoras gera DUAS linhas
 * distintas (find-by-telefone escopado por corretora_id). Sem UNIQUE em telefone,
 * fazemos read-then-write — race rara (1ª msg simultânea) é tolerável.
 */
async function obterOuCriarCliente(
  telefone: string,
  corretoraId: string,
  nome?: string | null,
): Promise<string> {
  const sb = getSupabaseAdmin();
  const { data: existente, error: errSel } = await sb
    .from("clientes")
    .select("id, nome")
    .eq("telefone", telefone)
    .eq("corretora_id" as never, corretoraId as never)
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
    .insert({ telefone, nome: nome ?? null, corretora_id: corretoraId } as never)
    .select("id")
    .single();
  if (errIns) throw errIns;
  return inserido.id;
}

/** Normaliza um JSONB do banco para objeto (array/null/escalar → {}). */
function comoObjeto(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Estados TERMINAIS em que uma nova mensagem do cliente recorrente REABRE a
 * conversa em modo REVISÃO (atendimento anterior concluído; o cliente voltou).
 * NÃO inclui estados em que a equipe ainda trabalha (aguardando_cotacao,
 * humano_assumiu, bloqueado_vip, aceite_registrado, proposta_transmitida) —
 * reabrir ali atropelaria o time. Conjunto pequeno e nomeado para fácil ajuste.
 */
const ESTADOS_REABRE_REVISAO: ReadonlySet<string> = new Set([
  "cotacao_enviada",
  "apolice_emitida",
]);

/** True se há dados de roteiro reaproveitáveis (categoria com roteiro + ≥1 campo preenchido). Pura. */
export function temDadosReaproveitaveis(
  dados: Record<string, unknown>,
  categoria: string | null | undefined,
): boolean {
  const roteiro = getRoteiro(categoria as CategoriaConversa | null);
  if (!roteiro) return false;
  return roteiro.campos.some((c) => {
    const v = dados[c.chave];
    return v != null && v !== "";
  });
}

/**
 * Decide se uma conversa EXISTENTE deve ser reaberta em modo revisão (Parte B):
 * estado terminal elegível + ainda não em revisão + há dados a revisar. Pura.
 */
export function deveReabrirEmRevisao(
  estado: string,
  dadosBot: Record<string, unknown>,
  dadosColetados: Record<string, unknown>,
  categoria: string | null | undefined,
): boolean {
  return (
    ESTADOS_REABRE_REVISAO.has(estado) &&
    (dadosBot as { revisao_pendente?: unknown }).revisao_pendente !== true &&
    temDadosReaproveitaveis(dadosColetados, categoria)
  );
}

/**
 * Busca os dados já capturados do cliente num atendimento ANTERIOR já encerrado
 * (qualquer linha — o cliente é único por telefone) para reaproveitar numa
 * conversa nova. Retorna null quando não há nada útil a revisar (sem roteiro ou
 * sem campos preenchidos → fluxo normal de cliente novo). NÃO copia o dados_bot
 * antigo (evita arrastar formulario/cotacao_em_falha/campos_forcados).
 */
async function buscarDadosAnteriores(
  clienteId: string,
  corretoraId: string,
): Promise<{ dadosColetados: Record<string, unknown>; categoria: CategoriaConversa } | null> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("conversas")
    .select("dados_coletados, categoria")
    .eq("cliente_id", clienteId)
    // Defesa-em-profundidade: cliente já é por-corretora, mas reforçamos o tenant.
    .eq("corretora_id" as never, corretoraId as never)
    .eq("estado", "encerrado")
    .order("ultima_mensagem_em", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { dados_coletados: unknown; categoria: string | null };
  const dados = comoObjeto(row.dados_coletados);
  if (!temDadosReaproveitaveis(dados, row.categoria)) return null;
  return { dadosColetados: dados, categoria: row.categoria as CategoriaConversa };
}

/** Acha uma conversa aberta (estado != 'encerrado') para (canal, cliente) ou cria. */
async function obterOuCriarConversaAberta(
  canalId: string,
  clienteId: string,
  tenant: CanalTenant,
): Promise<ConversaRow> {
  const sb = getSupabaseAdmin();
  const { data: existente, error: errSel } = await sb
    .from("conversas")
    .select("id, canal_id, cliente_id, estado, dados_coletados, dados_bot, categoria")
    .eq("canal_id", canalId)
    .eq("cliente_id", clienteId)
    .neq("estado", "encerrado")
    .order("criado_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (errSel) throw errSel;
  if (existente) {
    const row = existente as ConversaRow & {
      dados_coletados?: unknown;
      dados_bot?: unknown;
      categoria?: string | null;
    };
    // Parte B — cliente recorrente voltou após o atendimento concluído: reabre a
    // conversa em modo REVISÃO (reaproveita os próprios dados desta conversa).
    // Só em estados terminais, com dados a revisar e se ainda não está em revisão.
    const dadosBot = comoObjeto(row.dados_bot);
    if (deveReabrirEmRevisao(row.estado, dadosBot, comoObjeto(row.dados_coletados), row.categoria)) {
      const novoDadosBot = { ...dadosBot, revisao_pendente: true, reuso_de_dados: true };
      await sb
        .from("conversas")
        .update({ estado: "bot_ativo", dados_bot: novoDadosBot })
        .eq("id", row.id);
      logger.info("[wa.persistence] conversa reaberta em revisão (cliente recorrente)", {
        conversaId: row.id,
        estadoAnterior: row.estado,
      });
      return { id: row.id, canal_id: row.canal_id, cliente_id: row.cliente_id, estado: "bot_ativo" };
    }
    return {
      id: row.id,
      canal_id: row.canal_id,
      cliente_id: row.cliente_id,
      estado: row.estado,
    };
  }

  // Conversa NOVA — Parte A: se o cliente já tem dados de um atendimento anterior
  // encerrado, semeia a conversa em modo REVISÃO (apresentar tudo de uma vez e
  // perguntar se mudou algo); senão, começa do zero como antes.
  const anterior = await buscarDadosAnteriores(clienteId, tenant.corretoraId);
  // Tenant herdado do canal: corretora (isolamento) + ramo padrão da linha (decide
  // o roteiro/provider). ramo NULL → o bot trata como auto (retrocompat).
  const tenantCols = { corretora_id: tenant.corretoraId, ramo: tenant.ramoPadrao };
  const insert: Record<string, unknown> = anterior
    ? {
        ...tenantCols,
        canal_id: canalId,
        cliente_id: clienteId,
        estado: "bot_ativo",
        categoria: anterior.categoria,
        dados_coletados: anterior.dadosColetados,
        dados_bot: { revisao_pendente: true, reuso_de_dados: true },
      }
    : {
        ...tenantCols,
        canal_id: canalId,
        cliente_id: clienteId,
        estado: "bot_ativo",
        categoria: "seguro_novo", // ENUM do banco; o adapter do front converte para CategoriaBot.
      };

  const { data: nova, error: errIns } = await sb
    .from("conversas")
    .insert(insert)
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
  /**
   * Telefone REAL (E.164) resolvido pelo handler quando o jid é `@lid` (LID). Se
   * presente, vira o `clientes.telefone`; senão, caímos no jidParaE164(jidRemoto)
   * — que p/ LID é um número falso (corrigido depois via bot perguntando/edição).
   */
  telefoneReal?: string | null;
  /** Tipo de mídia da entrada (ex.: "audio"). Ausente → null (texto puro, como hoje). */
  midiaTipo?: string | null;
  /** Path no Storage da mídia original (ex.: áudio). Ausente → null. */
  midiaUrl?: string | null;
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
  // Preferimos o telefone REAL resolvido pelo handler (quando o jid é @lid);
  // senão derivamos do jid (p/ @s.whatsapp.net é exato; p/ @lid é um fallback
  // que será corrigido depois). wa_jid (gravado abaixo) é a chave de ENVIO.
  const telefone = input.telefoneReal ?? jidParaE164(input.jidRemoto);
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

  // Resolve o tenant a partir do CANAL (única âncora confiável no inbound).
  const tenant = await lerTenantDoCanal(input.canalId);
  const clienteId = await obterOuCriarCliente(telefone, tenant.corretoraId, input.pushName ?? null);
  const conversa = await obterOuCriarConversaAberta(input.canalId, clienteId, tenant);

  const msg: MensagemInsert = {
    conversa_id: conversa.id,
    direcao: "entrada",
    origem: "cliente",
    corpo: input.texto,
    midia_tipo: input.midiaTipo ?? null,
    midia_url: input.midiaUrl ?? null,
    twilio_message_sid: input.providerMsgId ?? null,
    enviada_em: (input.enviadaEm ?? new Date()).toISOString(),
    // Denormalizado do tenant da conversa (RLS/realtime/queries por corretora).
    corretora_id: tenant.corretoraId,
  } as MensagemInsert & { corretora_id: string };

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
