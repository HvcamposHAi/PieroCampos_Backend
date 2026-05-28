/**
 * Eventos do socket Baileys → persistência Supabase.
 *
 * Three streams:
 *   - connection.update: QR / open / close → atualizar canais.qr_code/status
 *   - messages.upsert:   nova msg do cliente → registrar entrada na fila
 *   - creds.update:      mudou cred do device → salvar em wa_auth_state
 *
 * Reconnect: implementado fora daqui (sessionManager observa transição).
 */
import { DisconnectReason, type WASocket, type WAMessage } from "@whiskeysockets/baileys";
import { getEnv } from "../../config/env";
import { processarMensagem } from "../../services/bot.service";
import { logger } from "../../utils/logger";
import {
  atualizarCanal,
  jidParaE164,
  registrarMensagemEntrada,
} from "./persistence";
import { sessionManager } from "./sessionManager";
import { apagarAuthState } from "./supabaseAuthState";

export type MotivoFechamento =
  | "logged_out"
  | "replaced"
  | "timeout"
  | "outro";

export interface CallbacksHandlers {
  onAberto?: (info: { numeroE164: string | null; displayName: string | null }) => void;
  onFechado?: (motivo: MotivoFechamento, reconectavel: boolean) => void;
  onAguardandoQr?: (qr: string, expiresAt: Date) => void;
}

function extrairTexto(m: WAMessage): string | null {
  const msg = m.message;
  if (!msg) return null;
  return (
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    msg.imageMessage?.caption ??
    msg.videoMessage?.caption ??
    null
  );
}

function classificarMotivo(reasonCode: number | undefined): {
  motivo: MotivoFechamento;
  reconectavel: boolean;
} {
  if (reasonCode === DisconnectReason.loggedOut) {
    return { motivo: "logged_out", reconectavel: false };
  }
  if (reasonCode === DisconnectReason.connectionReplaced) {
    return { motivo: "replaced", reconectavel: false };
  }
  if (reasonCode === DisconnectReason.timedOut) {
    return { motivo: "timeout", reconectavel: true };
  }
  return { motivo: "outro", reconectavel: true };
}

export function registrarHandlers(
  canalId: string,
  sock: WASocket,
  saveCreds: () => Promise<void>,
  callbacks: CallbacksHandlers = {},
): void {
  const env = getEnv();

  sock.ev.on("creds.update", () => {
    saveCreds().catch((e) =>
      logger.error("[wa.handlers] saveCreds falhou", { canalId, erro: (e as Error).message }),
    );
  });

  sock.ev.on("connection.update", async (update) => {
    try {
      if (update.qr) {
        const expiresAt = new Date(Date.now() + env.WA_QR_TTL_MS);
        await atualizarCanal(canalId, {
          status: "aguardando_qr",
          qr_code: update.qr,
          qr_expires_at: expiresAt.toISOString(),
        });
        callbacks.onAguardandoQr?.(update.qr, expiresAt);
        logger.info("[wa.handlers] QR emitido", { canalId, expiresAt });
        // QR nunca vai pro log — só timestamp.
      }

      if (update.connection === "open") {
        const userId = sock.user?.id ?? null;
        const numeroE164 = userId ? jidParaE164(userId) : null;
        const displayName = sock.user?.name ?? null;
        await atualizarCanal(canalId, {
          status: "conectado",
          qr_code: null,
          qr_expires_at: null,
          numero_e164: numeroE164,
          display_name: displayName,
          last_connected_at: new Date().toISOString(),
          last_disconnect_reason: null,
        });
        callbacks.onAberto?.({ numeroE164, displayName });
        logger.info("[wa.handlers] canal conectado", { canalId, numeroE164 });
      }

      if (update.connection === "close") {
        const reasonCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;
        const { motivo, reconectavel } = classificarMotivo(reasonCode);
        logger.warn("[wa.handlers] canal fechou", { canalId, motivo, reasonCode });

        if (motivo === "logged_out") {
          await apagarAuthState(canalId);
          await atualizarCanal(canalId, {
            status: "desconectado",
            qr_code: null,
            qr_expires_at: null,
            last_disconnect_reason: "logout_remoto",
          });
        } else if (motivo === "replaced") {
          // Outra sessão Baileys assumiu o mesmo número (pareamento duplicado).
          await atualizarCanal(canalId, {
            status: "desconectado",
            qr_code: null,
            qr_expires_at: null,
            last_disconnect_reason: "conexao_substituida",
          });
        } else {
          await atualizarCanal(canalId, {
            status: "conectando",
            last_disconnect_reason: `${motivo}_code_${reasonCode ?? "?"}`,
          });
        }
        callbacks.onFechado?.(motivo, reconectavel);
      }
    } catch (e) {
      logger.error("[wa.handlers] connection.update falhou", {
        canalId,
        erro: (e as Error).message,
      });
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        if (m.key.fromMe) continue; // saída — não processamos como entrada
        if (!m.key.remoteJid) continue;
        if (m.key.remoteJid.endsWith("@g.us")) continue; // ignora grupos por enquanto
        const texto = extrairTexto(m);
        if (!texto) continue; // mídia sem caption diferido para outra fase
        const jidRemoto = m.key.remoteJid;
        const registro = await registrarMensagemEntrada({
          canalId,
          jidRemoto,
          texto,
          pushName: m.pushName ?? undefined,
          providerMsgId: m.key.id ?? undefined,
          enviadaEm: m.messageTimestamp
            ? new Date(Number(m.messageTimestamp) * 1000)
            : undefined,
        });

        if (!registro || registro.duplicada) continue;

        // Aciona o agente Bia. Função `enviar` injetada para evitar acoplar o
        // bot.service ao sessionManager (testes podem mockar).
        await processarMensagem({
          canalId,
          conversaId: registro.conversaId,
          jidRemoto,
          textoCliente: texto,
          enviar: async (respostaTexto) => {
            await sessionManager.enviarTextoBot({
              canalId,
              conversaId: registro.conversaId,
              jid: jidRemoto,
              texto: respostaTexto,
            });
          },
        });
      } catch (e) {
        logger.error("[wa.handlers] messages.upsert item falhou", {
          canalId,
          msgId: m.key.id,
          erro: (e as Error).message,
        });
      }
    }
  });
}
