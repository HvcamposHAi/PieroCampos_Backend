/**
 * Avisos de REAUTENTICAÇÃO do Segfy (2FA) ao operador. Dois canais, best-effort
 * (nunca lança — um aviso jamais quebra a cotação nem o bot):
 *   - SINO in-app: insere em `notificacoes` (tipo 'segfy_reauth') p/ cada admin ativo.
 *   - WhatsApp: se SEGFY_ALERTA_WPP_E164 setado, manda 1 mensagem via a 1ª linha
 *     conectada (mesma infra do alerta de handoff: sessionManager.enviarAlerta).
 *
 * Nunca loga código/cookie/token/senha.
 */
import { getEnv } from "../config/env";
import { getSupabaseAdmin } from "../integrations/whatsapp/supabase";
import { logger } from "../utils/logger";

const TITULO = "Segfy precisa de reautenticação";

/** Dispara o aviso nos dois canais em paralelo; engole erros (best-effort). */
export async function notificarReauthNecessaria(motivo: string): Promise<void> {
  await Promise.allSettled([notificarSino(motivo), notificarWhatsapp(motivo)]);
}

/** Insere a notificação in-app p/ os admins ativos (fallback: todos os ativos). */
async function notificarSino(motivo: string): Promise<void> {
  try {
    const sb = getSupabaseAdmin();
    const { data: admins } = await sb
      .from("operadores")
      .select("id")
      .eq("ativo", true)
      .eq("perfil", "admin");
    let alvos = (admins ?? []) as Array<{ id: string }>;
    if (alvos.length === 0) {
      const { data: todos } = await sb.from("operadores").select("id").eq("ativo", true);
      alvos = (todos ?? []) as Array<{ id: string }>;
      if (alvos.length > 0) logger.warn("[segfy.alertas] sem admin ativo; notificando todos os operadores");
    }
    if (alvos.length === 0) {
      logger.warn("[segfy.alertas] nenhum operador ativo para notificar (sino)");
      return;
    }
    const linhas = alvos.map((a) => ({
      operador_id: a.id,
      conversa_id: null,
      tipo: "segfy_reauth",
      titulo: TITULO,
      corpo: motivo,
    }));
    const { error } = await sb.from("notificacoes").insert(linhas);
    if (error) logger.warn("[segfy.alertas] insert notificacoes falhou", { erro: error.message });
    else logger.info("[segfy.alertas] aviso in-app enviado", { destinatarios: alvos.length });
  } catch (e) {
    logger.warn("[segfy.alertas] sino falhou", { erro: (e as Error).message });
  }
}

/** Envia o aviso por WhatsApp ao número configurado (no-op se não configurado). */
async function notificarWhatsapp(motivo: string): Promise<void> {
  const numero = getEnv().SEGFY_ALERTA_WPP_E164.trim();
  if (!numero) return;
  try {
    const canalId = await primeiraLinhaConectada();
    if (!canalId) {
      logger.warn("[segfy.alertas] sem linha conectada para o aviso por WhatsApp");
      return;
    }
    // import dinâmico: evita carregar o Baileys quando o WhatsApp está desligado.
    const { sessionManager } = await import("../integrations/whatsapp/sessionManager");
    await sessionManager.enviarAlerta({
      canalId,
      numeroDestino: numero,
      texto: `⚠️ ${TITULO}\n${motivo}\nReautentique em Admin › Segfy.`,
    });
    logger.info("[segfy.alertas] aviso por WhatsApp enviado");
  } catch (e) {
    logger.warn("[segfy.alertas] WhatsApp falhou", { erro: (e as Error).message });
  }
}

async function primeiraLinhaConectada(): Promise<string | null> {
  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("canais")
    .select("id")
    .eq("status", "conectado")
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}
