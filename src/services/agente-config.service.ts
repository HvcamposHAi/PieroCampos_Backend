/**
 * Configuração de COMPORTAMENTO da Bia por canal (Admin > Bia).
 *
 * Modelo "default + override": uma linha PADRÃO (canal_id IS NULL) vale para
 * todas as linhas; cada canal pode ter um override (canal_id setado) que
 * sobrescreve campo-a-campo. Só estilo de conversa — tom, persona/abordagem,
 * saudação, exemplos e criatividade. As REGRAS ABSOLUTAS de compliance/LGPD
 * vivem no SYSTEM_PROMPT_BASE e NUNCA são tocadas aqui.
 *
 * A tabela `canal_agente_config` é acessível só pelo backend (service_role,
 * sem policies RLS) — espelha o padrão do Segfy/wa_auth_state e evita de
 * propósito a recursão de RLS (ver memória rls-perfil-operador-arquitetura).
 *
 * Zero impacto: se a tabela não existir / a leitura falhar / não houver
 * nenhuma linha → obterConfigEfetiva devolve null e o bot.service não injeta
 * bloco de personalização nem temperatura (comportamento idêntico ao atual).
 */
import { getSupabaseAdmin } from "../integrations/whatsapp/supabase";
import {
  CATEGORIAS_COM_ROTEIRO,
  getCatalogoCampos,
  getRoteiro,
  type CatalogoCategoria,
  type PerguntaCustom,
} from "../lib/roteiros";
import { logger } from "../utils/logger";

/** Mapa por categoria → chaves de campos opcionais desligados. */
export type CamposExcluidos = Record<string, string[]>;
/** Mapa por categoria → perguntas customizadas da linha. */
export type PerguntasCustomizadas = Record<string, PerguntaCustom[]>;
/** Forma frouxa aceita na ENTRADA (id é opcional; o serviço normaliza). */
export type PerguntasCustomizadasInput = Record<
  string,
  Array<{ id?: string; chave?: string; pergunta?: string; dica?: string | null }>
>;

export type TomVoz =
  | "proximo_caloroso"
  | "formal_profissional"
  | "direto_objetivo"
  | "entusiasta";

export type Criatividade = "consistente" | "equilibrado" | "criativo";

/** Nível de uso de emoji da Bia na linha. 'moderado' = comportamento atual ("máx. 1"). */
export type Emojis = "sem" | "moderado" | "a_vontade";

/** Objetivo/postura da Bia na linha — orienta a intenção (não muda o roteiro). */
export type Objetivo = "cotacao" | "atendimento" | "aquecer" | "venda";

/** Mapa puro preset → temperature da Anthropic. Testável isoladamente. */
export const CRIATIVIDADE_TEMPERATURA: Record<Criatividade, number> = {
  consistente: 0.3,
  equilibrado: 0.6,
  criativo: 0.9,
};

const TONS_VALIDOS: ReadonlySet<string> = new Set<TomVoz>([
  "proximo_caloroso",
  "formal_profissional",
  "direto_objetivo",
  "entusiasta",
]);
const CRIATIVIDADES_VALIDAS: ReadonlySet<string> = new Set<Criatividade>([
  "consistente",
  "equilibrado",
  "criativo",
]);
const OBJETIVOS_VALIDOS: ReadonlySet<string> = new Set<Objetivo>([
  "cotacao",
  "atendimento",
  "aquecer",
  "venda",
]);
const EMOJIS_VALIDOS: ReadonlySet<string> = new Set<Emojis>(["sem", "moderado", "a_vontade"]);

/** Linha crua da tabela (forma devolvida à tela do Admin). */
export interface AgenteConfigRow {
  canal_id: string | null;
  ativo: boolean;
  tom_voz: TomVoz;
  persona: string | null;
  saudacao: string | null;
  exemplos: string | null;
  variar_texto: boolean;
  criatividade: Criatividade;
  objetivo: Objetivo;
  emojis: Emojis;
  estilo_amostra: string | null;
  campos_excluidos: CamposExcluidos;
  perguntas_customizadas: PerguntasCustomizadas;
  atualizado_em: string | null;
  atualizado_por: string | null;
}

/** Config já resolvida (padrão+override) que o bot.service consome. */
export interface ConfigEfetiva {
  tomVoz: TomVoz;
  persona: string | null;
  saudacao: string | null;
  exemplos: string | null;
  variarTexto: boolean;
  criatividade: Criatividade;
  objetivo: Objetivo;
  emojis: Emojis;
  estiloAmostra: string | null;
  camposExcluidos: CamposExcluidos;
  perguntasCustomizadas: PerguntasCustomizadas;
  temperature: number;
}

export interface AgenteConfigAdmin {
  padrao: AgenteConfigRow | null;
  linhas: Array<{ canal_id: string; apelido: string; config: AgenteConfigRow | null }>;
  /** Catálogo de campos por categoria (fonte: roteiros.ts) para a tela. */
  catalogo: CatalogoCategoria[];
}

const COLUNAS =
  "canal_id, ativo, tom_voz, persona, saudacao, exemplos, variar_texto, criatividade, objetivo, emojis, estilo_amostra, campos_excluidos, perguntas_customizadas, atualizado_em, atualizado_por";

/** Normaliza um jsonb que deveria ser objeto { categoria: [...] }; senão {}. */
function comoMapa<T>(v: unknown): Record<string, T> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, T>) : {};
}

/** Texto vazio/só-espaços vira null (para não atropelar o fallback do padrão). */
function nuloSeVazio(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** Texto do override vence se preenchido; senão cai no padrão. */
function preferir(o: string | null | undefined, p: string | null | undefined): string | null {
  const ov = nuloSeVazio(o);
  return ov ?? nuloSeVazio(p);
}

/** Merge padrão+override (ao menos um não-nulo). Override sempre vence quando ativo. */
export function mergeConfig(
  padrao: AgenteConfigRow | null,
  override: AgenteConfigRow | null,
): ConfigEfetiva {
  const tomVoz = override?.tom_voz ?? padrao?.tom_voz ?? "proximo_caloroso";
  const criatividade = override?.criatividade ?? padrao?.criatividade ?? "equilibrado";
  const variarTexto = override?.variar_texto ?? padrao?.variar_texto ?? true;
  const objetivo = override?.objetivo ?? padrao?.objetivo ?? "cotacao";
  const emojis = override?.emojis ?? padrao?.emojis ?? "moderado";
  // Campos da cotação: o override (quando existe) substitui o objeto inteiro — a
  // UI pré-semeia o override a partir do padrão, então é coerente.
  const fonteCampos = override ?? padrao;
  return {
    tomVoz,
    persona: preferir(override?.persona, padrao?.persona),
    saudacao: preferir(override?.saudacao, padrao?.saudacao),
    exemplos: preferir(override?.exemplos, padrao?.exemplos),
    variarTexto,
    criatividade,
    objetivo,
    emojis,
    estiloAmostra: preferir(override?.estilo_amostra, padrao?.estilo_amostra),
    camposExcluidos: comoMapa<string[]>(fonteCampos?.campos_excluidos),
    perguntasCustomizadas: comoMapa<PerguntaCustom[]>(fonteCampos?.perguntas_customizadas),
    temperature: CRIATIVIDADE_TEMPERATURA[criatividade],
  };
}

/**
 * Resolve a config efetiva de um canal: lê o padrão (canal_id null) e o override
 * do canal (se ativo) e faz o merge. Devolve null quando não há nenhuma linha
 * ou em qualquer erro de leitura — degrada para o comportamento atual da Bia.
 */
export async function obterConfigEfetiva(canalId: string | null): Promise<ConfigEfetiva | null> {
  try {
    const sb = getSupabaseAdmin();
    // Config é POR-CORRETORA (inclusive o padrão canal_id IS NULL). Resolve a
    // corretora do canal para não misturar padrões de corretoras diferentes.
    const corretoraId = canalId ? await corretoraDoCanal(canalId) : null;
    let q = sb.from("canal_agente_config").select(COLUNAS);
    if (corretoraId) q = q.eq("corretora_id" as never, corretoraId as never);
    q = canalId ? q.or(`canal_id.is.null,canal_id.eq.${canalId}`) : q.is("canal_id", null);
    const { data, error } = await q;
    if (error) {
      logger.warn("[agente.cfg] leitura falhou; sem personalização", { erro: error.message });
      return null;
    }
    const linhas = (data ?? []) as AgenteConfigRow[];
    const padrao = linhas.find((l) => l.canal_id === null) ?? null;
    const override = canalId
      ? linhas.find((l) => l.canal_id === canalId && l.ativo !== false) ?? null
      : null;
    if (!padrao && !override) return null;
    return mergeConfig(padrao, override);
  } catch (e) {
    logger.warn("[agente.cfg] exceção na leitura; sem personalização", {
      erro: (e as Error).message,
    });
    return null;
  }
}

/** corretora_id do canal (isolamento da config por linha). null se não achar. */
async function corretoraDoCanal(canalId: string): Promise<string | null> {
  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("canais")
    .select("corretora_id" as never)
    .eq("id", canalId)
    .maybeSingle();
  return (data as { corretora_id?: string } | null)?.corretora_id ?? null;
}

/**
 * Padrão + todas as linhas (com override) para a tela do Admin, ESCOPADO à
 * corretora efetiva: só os canais e configs daquela corretora. Isso corrige o
 * vazamento (Admin via service_role mostrava linhas de outra corretora).
 */
export async function obterConfigAdmin(corretoraId: string): Promise<AgenteConfigAdmin> {
  const sb = getSupabaseAdmin();
  const [cfgRes, canaisRes] = await Promise.all([
    sb.from("canal_agente_config").select(COLUNAS).eq("corretora_id" as never, corretoraId as never),
    sb.from("canais").select("id, apelido").eq("ativo", true).eq("corretora_id" as never, corretoraId as never),
  ]);
  if (cfgRes.error) throw new Error(`obterConfigAdmin(config): ${cfgRes.error.message}`);
  if (canaisRes.error) throw new Error(`obterConfigAdmin(canais): ${canaisRes.error.message}`);

  const configs = (cfgRes.data ?? []) as AgenteConfigRow[];
  const padrao = configs.find((c) => c.canal_id === null) ?? null;
  const canais = (canaisRes.data ?? []) as Array<{ id: string; apelido: string }>;
  const linhas = canais.map((k) => ({
    canal_id: k.id,
    apelido: k.apelido,
    config: configs.find((c) => c.canal_id === k.id) ?? null,
  }));
  return { padrao, linhas, catalogo: getCatalogoCampos() };
}

/**
 * Saneia os mapas por categoria antes de gravar:
 *  - campos_excluidos: mantém só categorias com roteiro e só chaves de campos
 *    OPCIONAIS conhecidos (obrigatórios NUNCA podem ser desligados — Segfy/LGPD).
 *  - perguntas_customizadas: força prefixo custom_, dedup por chave, limites.
 */
function sanearCamposExcluidos(bruto: CamposExcluidos | undefined): CamposExcluidos {
  const out: CamposExcluidos = {};
  for (const cat of CATEGORIAS_COM_ROTEIRO) {
    const roteiro = getRoteiro(cat);
    if (!roteiro) continue;
    const opcionais = new Set(roteiro.campos.filter((c) => !c.obrigatorio).map((c) => c.chave));
    const pedidos = Array.isArray(bruto?.[cat]) ? bruto![cat] : [];
    const validos = [...new Set(pedidos)].filter((ch) => opcionais.has(ch));
    if (validos.length > 0) out[cat] = validos;
  }
  return out;
}

const RE_CHAVE_CUSTOM = /^custom_[a-z0-9_]{1,40}$/;
const MAX_CUSTOM_POR_CATEGORIA = 10;

function sanearPerguntasCustom(bruto: PerguntasCustomizadasInput | undefined): PerguntasCustomizadas {
  const out: PerguntasCustomizadas = {};
  for (const cat of CATEGORIAS_COM_ROTEIRO) {
    const lista = Array.isArray(bruto?.[cat]) ? bruto![cat] : [];
    const vistos = new Set<string>();
    const limpas: PerguntaCustom[] = [];
    for (const q of lista) {
      const pergunta = (q?.pergunta ?? "").trim();
      const chave = (q?.chave ?? "").trim();
      if (!pergunta || !RE_CHAVE_CUSTOM.test(chave) || vistos.has(chave)) continue;
      vistos.add(chave);
      limpas.push({
        id: q.id || chave,
        chave,
        pergunta: pergunta.slice(0, 200),
        dica: q.dica ? String(q.dica).slice(0, 200) : null,
      });
      if (limpas.length >= MAX_CUSTOM_POR_CATEGORIA) break;
    }
    if (limpas.length > 0) out[cat] = limpas;
  }
  return out;
}

export interface SalvarConfigInput {
  /** Corretora EFETIVA dona da config (override do canal ou padrão da corretora). */
  corretoraId: string;
  canalId: string | null;
  tom_voz: TomVoz;
  persona?: string | null;
  saudacao?: string | null;
  exemplos?: string | null;
  variar_texto: boolean;
  criatividade: Criatividade;
  objetivo: Objetivo;
  emojis: Emojis;
  estilo_amostra?: string | null;
  campos_excluidos?: CamposExcluidos;
  perguntas_customizadas?: PerguntasCustomizadasInput;
  ativo?: boolean;
  porEmail?: string | null;
}

async function acharIdLinha(canalId: string | null, corretoraId: string): Promise<string | null> {
  const sb = getSupabaseAdmin();
  let q = sb.from("canal_agente_config").select("id").eq("corretora_id" as never, corretoraId as never);
  q = canalId ? q.eq("canal_id", canalId) : q.is("canal_id", null);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`acharIdLinha: ${error.message}`);
  return (data as { id?: string } | null)?.id ?? null;
}

/**
 * Salva a config padrão (canalId null) ou o override de um canal. Faz
 * select-then-update/insert (em vez de upsert) porque a unicidade vive em
 * índices PARCIAIS, que o onConflict do supabase-js não enxerga.
 */
export async function salvarConfig(input: SalvarConfigInput): Promise<void> {
  if (!TONS_VALIDOS.has(input.tom_voz)) throw new Error("tom_voz inválido");
  if (!CRIATIVIDADES_VALIDAS.has(input.criatividade)) throw new Error("criatividade inválida");
  if (!OBJETIVOS_VALIDOS.has(input.objetivo)) throw new Error("objetivo inválido");
  if (!EMOJIS_VALIDOS.has(input.emojis)) throw new Error("emojis inválido");

  // Se for override de um canal, valida que o canal é DA corretora (anti cross-tenant).
  if (input.canalId) {
    const dono = await corretoraDoCanal(input.canalId);
    if (dono !== input.corretoraId) {
      throw new Error(`salvarConfig: canal de outra corretora (404)`);
    }
  }

  const sb = getSupabaseAdmin();
  const payload = {
    corretora_id: input.corretoraId,
    canal_id: input.canalId,
    ativo: input.ativo ?? true,
    tom_voz: input.tom_voz,
    persona: nuloSeVazio(input.persona),
    saudacao: nuloSeVazio(input.saudacao),
    exemplos: nuloSeVazio(input.exemplos),
    variar_texto: input.variar_texto,
    criatividade: input.criatividade,
    objetivo: input.objetivo,
    emojis: input.emojis,
    estilo_amostra: nuloSeVazio(input.estilo_amostra),
    campos_excluidos: sanearCamposExcluidos(input.campos_excluidos),
    perguntas_customizadas: sanearPerguntasCustom(input.perguntas_customizadas),
    atualizado_em: new Date().toISOString(),
    atualizado_por: input.porEmail ?? null,
  };

  const existenteId = await acharIdLinha(input.canalId, input.corretoraId);
  if (existenteId) {
    const { error } = await sb.from("canal_agente_config").update(payload as never).eq("id", existenteId);
    if (error) throw new Error(`salvarConfig(update): ${error.message}`);
  } else {
    const { error } = await sb.from("canal_agente_config").insert(payload as never);
    if (error) throw new Error(`salvarConfig(insert): ${error.message}`);
  }
  logger.info("[agente.cfg] config salva", { canal_id: input.canalId, por: input.porEmail });
}

/** Lê a row CRUA (override do canal, ou padrão quando canalId=null). Usada para
 *  PRESERVAR campos avançados num save parcial (app móvel do operador). */
async function lerLinhaRaw(canalId: string | null, corretoraId: string): Promise<AgenteConfigRow | null> {
  const sb = getSupabaseAdmin();
  let q = sb.from("canal_agente_config").select(COLUNAS).eq("corretora_id" as never, corretoraId as never);
  q = canalId ? q.eq("canal_id", canalId) : q.is("canal_id", null);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`lerLinhaRaw: ${error.message}`);
  return (data as AgenteConfigRow | null) ?? null;
}

/** Campos ESSENCIAIS editáveis no app móvel (sem campos da cotação / mensagens). */
export interface EssencialAgente {
  objetivo: Objetivo;
  tom_voz: TomVoz;
  criatividade: Criatividade;
  persona: string | null;
  saudacao: string | null;
}

/** Config essencial EFETIVA (padrão+override) da linha — para a tela do operador. */
export async function obterEssencialLinha(canalId: string): Promise<EssencialAgente> {
  const efetiva = await obterConfigEfetiva(canalId);
  return {
    objetivo: efetiva?.objetivo ?? "cotacao",
    tom_voz: efetiva?.tomVoz ?? "proximo_caloroso",
    criatividade: efetiva?.criatividade ?? "equilibrado",
    persona: efetiva?.persona ?? null,
    saudacao: efetiva?.saudacao ?? null,
  };
}

/**
 * Salva SÓ os campos essenciais do override de UMA linha (app móvel do operador),
 * PRESERVANDO o que o admin configurou no portal: exemplos, variar_texto,
 * campos_excluidos e perguntas_customizadas. Base = override existente da linha;
 * se a linha ainda não tinha override, herda do PADRÃO (canal_id null). Assim o
 * operador nunca apaga a configuração avançada do admin.
 */
export async function salvarConfigEssencialLinha(input: {
  corretoraId: string;
  canalId: string;
  patch: EssencialAgente;
  porEmail?: string | null;
}): Promise<void> {
  const base =
    (await lerLinhaRaw(input.canalId, input.corretoraId)) ??
    (await lerLinhaRaw(null, input.corretoraId));
  await salvarConfig({
    corretoraId: input.corretoraId,
    canalId: input.canalId,
    objetivo: input.patch.objetivo,
    tom_voz: input.patch.tom_voz,
    criatividade: input.patch.criatividade,
    persona: input.patch.persona,
    saudacao: input.patch.saudacao,
    // PRESERVA os avançados (vêm do override existente ou do padrão):
    exemplos: base?.exemplos ?? null,
    variar_texto: base?.variar_texto ?? true,
    emojis: base?.emojis ?? "moderado",
    estilo_amostra: base?.estilo_amostra ?? null,
    campos_excluidos: base?.campos_excluidos,
    perguntas_customizadas: base?.perguntas_customizadas,
    porEmail: input.porEmail,
  });
}

/** Remove o override de um canal → a linha volta a herdar o padrão. */
export async function removerOverride(canalId: string, corretoraId: string): Promise<void> {
  const sb = getSupabaseAdmin();
  // Escopado por corretora: nunca apaga override de canal de outra corretora.
  const { error } = await sb
    .from("canal_agente_config")
    .delete()
    .eq("canal_id", canalId)
    .eq("corretora_id" as never, corretoraId as never);
  if (error) throw new Error(`removerOverride: ${error.message}`);
  logger.info("[agente.cfg] override removido", { canal_id: canalId, corretora_id: corretoraId });
}
