/**
 * Identidade e gate do Copiloto (assistente de BI do GESTOR).
 *
 * Duas defesas, ambas FAIL-CLOSED:
 *   1. `resolverGestorPorTelefone`: o número de quem mandou a mensagem TEM de estar
 *      na allowlist `gestor_autorizado` (ativo). Número desconhecido → null → o
 *      serviço recusa SEM tocar em nenhum dado. É o que impede que o vazamento do
 *      número da linha gestor exponha a carteira da corretora.
 *   2. `lerGestorConfig`: o recurso precisa estar LIGADO para a corretora
 *      (`gestor_assist_config.ativo`). Qualquer erro/linha ausente → desligado.
 *
 * `corretoraId` SEMPRE sai daqui (do número autenticado), NUNCA do texto/modelo —
 * é a âncora de isolamento multi-tenant de todas as queries de BI.
 */
import { getSupabaseAdmin } from "../../integrations/whatsapp/supabase";
import { normalizarTelefoneBr } from "../../lib/telefone";
import { logger } from "../../utils/logger";

export interface GestorIdentidade {
  gestorId: string;
  corretoraId: string;
  operadorId: string | null;
  nomeExibicao: string | null;
}

export interface GestorConfig {
  ativo: boolean;
  permitePdf: boolean;
  permiteGrafico: boolean;
}

const CONFIG_DESLIGADO: GestorConfig = { ativo: false, permitePdf: false, permiteGrafico: false };

/**
 * Resolve a identidade do gestor a partir do telefone (E.164/dígitos). Canoniza
 * via `normalizarTelefoneBr` dos dois lados (a allowlist é gravada já normalizada),
 * então compara igualdade exata. FAIL-CLOSED: número inválido/fora da allowlist/
 * inativo → null. Erro de infra também → null (nunca "abre" por dúvida).
 */
export async function resolverGestorPorTelefone(
  telefoneBruto: string | null | undefined,
): Promise<GestorIdentidade | null> {
  const e164 = normalizarTelefoneBr(telefoneBruto ?? "");
  if (!e164) return null;
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("gestor_autorizado")
      .select("id, corretora_id, operador_id, nome_exibicao, ativo")
      .eq("numero_e164", e164)
      .eq("ativo", true)
      .maybeSingle();
    if (error) {
      logger.warn("[gestor.identidade] lookup falhou; fail-closed", { erro: error.message });
      return null;
    }
    const row = data as {
      id?: string;
      corretora_id?: string | null;
      operador_id?: string | null;
      nome_exibicao?: string | null;
    } | null;
    if (!row?.id || !row.corretora_id) return null;
    return {
      gestorId: row.id,
      corretoraId: row.corretora_id,
      operadorId: row.operador_id ?? null,
      nomeExibicao: row.nome_exibicao ?? null,
    };
  } catch (e) {
    logger.warn("[gestor.identidade] exceção no lookup; fail-closed", { erro: (e as Error).message });
    return null;
  }
}

/**
 * Lê o toggle do recurso por corretora. FAIL-CLOSED: sem linha / erro → desligado.
 * Os sub-flags (pdf/gráfico) só valem com o recurso ligado.
 */
export async function lerGestorConfig(corretoraId: string): Promise<GestorConfig> {
  if (!corretoraId) return CONFIG_DESLIGADO;
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("gestor_assist_config")
      .select("ativo, permite_pdf, permite_grafico")
      .eq("corretora_id", corretoraId)
      .maybeSingle();
    if (error) {
      logger.warn("[gestor.identidade] lerGestorConfig falhou; fail-closed", { erro: error.message });
      return CONFIG_DESLIGADO;
    }
    const row = data as {
      ativo?: boolean | null;
      permite_pdf?: boolean | null;
      permite_grafico?: boolean | null;
    } | null;
    if (!row || row.ativo !== true) return CONFIG_DESLIGADO;
    return {
      ativo: true,
      permitePdf: row.permite_pdf !== false,
      permiteGrafico: row.permite_grafico === true,
    };
  } catch (e) {
    logger.warn("[gestor.identidade] lerGestorConfig exceção; fail-closed", { erro: (e as Error).message });
    return CONFIG_DESLIGADO;
  }
}

const tipoCanalCache = new Map<string, string | null>();

/**
 * Lê (e cacheia) `canais.tipo`. Usado pelo eventHandlers para decidir o desvio ao
 * Copiloto. O canal não muda de tipo em runtime, então o cache é seguro; testes
 * podem limpar com `_resetTipoCanalCache`.
 */
export async function lerTipoCanal(canalId: string): Promise<string | null> {
  if (!canalId) return null;
  if (tipoCanalCache.has(canalId)) return tipoCanalCache.get(canalId) ?? null;
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("canais")
      .select("tipo")
      .eq("id", canalId)
      .maybeSingle();
    if (error) {
      logger.warn("[gestor.identidade] lerTipoCanal falhou", { canalId, erro: error.message });
      return null;
    }
    const tipo = (data as { tipo?: string | null } | null)?.tipo ?? null;
    tipoCanalCache.set(canalId, tipo);
    return tipo;
  } catch (e) {
    logger.warn("[gestor.identidade] lerTipoCanal exceção", { canalId, erro: (e as Error).message });
    return null;
  }
}

/** Limpa o cache de tipo de canal (uso em testes / após alteração do canal). */
export function _resetTipoCanalCache(canalId?: string): void {
  if (canalId) tipoCanalCache.delete(canalId);
  else tipoCanalCache.clear();
}
