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
import { logger } from "../utils/logger";

export type TomVoz =
  | "proximo_caloroso"
  | "formal_profissional"
  | "direto_objetivo"
  | "entusiasta";

export type Criatividade = "consistente" | "equilibrado" | "criativo";

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
  temperature: number;
}

export interface AgenteConfigAdmin {
  padrao: AgenteConfigRow | null;
  linhas: Array<{ canal_id: string; apelido: string; config: AgenteConfigRow | null }>;
}

const COLUNAS =
  "canal_id, ativo, tom_voz, persona, saudacao, exemplos, variar_texto, criatividade, objetivo, atualizado_em, atualizado_por";

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
  return {
    tomVoz,
    persona: preferir(override?.persona, padrao?.persona),
    saudacao: preferir(override?.saudacao, padrao?.saudacao),
    exemplos: preferir(override?.exemplos, padrao?.exemplos),
    variarTexto,
    criatividade,
    objetivo,
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
    let q = sb.from("canal_agente_config").select(COLUNAS);
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

/** Padrão + todas as linhas (com override, se houver) para a tela do Admin. */
export async function obterConfigAdmin(): Promise<AgenteConfigAdmin> {
  const sb = getSupabaseAdmin();
  const [cfgRes, canaisRes] = await Promise.all([
    sb.from("canal_agente_config").select(COLUNAS),
    sb.from("canais").select("id, apelido").eq("ativo", true),
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
  return { padrao, linhas };
}

export interface SalvarConfigInput {
  canalId: string | null;
  tom_voz: TomVoz;
  persona?: string | null;
  saudacao?: string | null;
  exemplos?: string | null;
  variar_texto: boolean;
  criatividade: Criatividade;
  objetivo: Objetivo;
  ativo?: boolean;
  porEmail?: string | null;
}

async function acharIdLinha(canalId: string | null): Promise<string | null> {
  const sb = getSupabaseAdmin();
  let q = sb.from("canal_agente_config").select("id");
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

  const sb = getSupabaseAdmin();
  const payload = {
    canal_id: input.canalId,
    ativo: input.ativo ?? true,
    tom_voz: input.tom_voz,
    persona: nuloSeVazio(input.persona),
    saudacao: nuloSeVazio(input.saudacao),
    exemplos: nuloSeVazio(input.exemplos),
    variar_texto: input.variar_texto,
    criatividade: input.criatividade,
    objetivo: input.objetivo,
    atualizado_em: new Date().toISOString(),
    atualizado_por: input.porEmail ?? null,
  };

  const existenteId = await acharIdLinha(input.canalId);
  if (existenteId) {
    const { error } = await sb.from("canal_agente_config").update(payload).eq("id", existenteId);
    if (error) throw new Error(`salvarConfig(update): ${error.message}`);
  } else {
    const { error } = await sb.from("canal_agente_config").insert(payload);
    if (error) throw new Error(`salvarConfig(insert): ${error.message}`);
  }
  logger.info("[agente.cfg] config salva", { canal_id: input.canalId, por: input.porEmail });
}

/** Remove o override de um canal → a linha volta a herdar o padrão. */
export async function removerOverride(canalId: string): Promise<void> {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("canal_agente_config").delete().eq("canal_id", canalId);
  if (error) throw new Error(`removerOverride: ${error.message}`);
  logger.info("[agente.cfg] override removido", { canal_id: canalId });
}
