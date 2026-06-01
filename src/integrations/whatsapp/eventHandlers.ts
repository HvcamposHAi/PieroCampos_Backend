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
import {
  DisconnectReason,
  downloadMediaMessage,
  isLidUser,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { getEnv } from "../../config/env";
import { processarFormularioRecebido, processarMensagem } from "../../services/bot.service";
import { logger } from "../../utils/logger";
import { enfileirarCampoForcado } from "./conversas.dados";
import {
  atualizarCanal,
  jidParaE164,
  registrarMensagemEntrada,
  registrarStatusEntrega,
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

/**
 * Quando o remetente chega como `@lid` (privacidade do WhatsApp), o jid NÃO
 * contém o telefone real — `jidParaE164` produziria um número falso. Tenta
 * resolver o PN real de forma best-effort (APIs instáveis no Baileys 6.7.x, daí
 * o acesso 100% defensivo): (1) `m.key.senderPn`; (2) `signalRepository.
 * lidMapping.getPNForLID`. Retorna E.164 ou null. Para jids `@s.whatsapp.net`
 * retorna null (o caller usa jidParaE164, que já é exato).
 */
async function resolverTelefoneReal(
  sock: WASocket,
  m: WAMessage,
  jidRemoto: string,
): Promise<string | null> {
  if (!isLidUser(jidRemoto)) return null;
  const senderPn = (m.key as unknown as { senderPn?: string }).senderPn;
  if (senderPn && senderPn.endsWith("@s.whatsapp.net")) {
    const tel = jidParaE164(senderPn);
    if (tel) return tel;
  }
  try {
    const lm = (
      sock as unknown as {
        signalRepository?: {
          lidMapping?: { getPNForLID?: (j: string) => Promise<string | undefined> | string | undefined };
        };
      }
    ).signalRepository?.lidMapping;
    const pn = await lm?.getPNForLID?.(jidRemoto);
    if (pn && pn.endsWith("@s.whatsapp.net")) {
      const tel = jidParaE164(pn);
      if (tel) return tel;
    }
  } catch {
    /* lidMapping é instável nessa versão — ignora e cai no "bot pergunta". */
  }
  return null;
}

/**
 * Quando não foi possível obter o telefone real (jid `@lid` sem PN), pede ao bot
 * para perguntar o telefone ao cliente: enfileira o campo do roteiro. Tenta as
 * duas chaves possíveis (seguro_novo: `telefone_contato`; renovação: `telefone`)
 * — `enfileirarCampoForcado` valida contra o roteiro e ignora a inválida. Best-
 * effort: não bloqueia o fluxo do bot.
 */
async function pedirTelefoneSeNecessario(conversaId: string): Promise<void> {
  const agoraIso = new Date().toISOString();
  for (const chave of ["telefone_contato", "telefone"]) {
    try {
      await enfileirarCampoForcado({ conversaId, chave, porEmail: "sistema:lid", agoraIso });
    } catch {
      /* chave fora do roteiro da categoria — ignora */
    }
  }
}

/**
 * Logger silencioso estruturalmente compatível com a interface (ILogger) que o
 * Baileys exige no `downloadMediaMessage`. Nosso logger (utils/logger) tem outra
 * assinatura, então usamos um shim no-op — o download não precisa logar.
 */
const baileysLoggerSilencioso = {
  level: "silent",
  child: () => baileysLoggerSilencioso,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Quais tipos de `messages.upsert` processamos:
 *   - "notify": mensagem ao vivo.
 *   - "append": backlog entregue ao REABRIR o socket (mensagens recebidas
 *     durante hibernação/restart). Precisamos processar p/ a Bia não deixar o
 *     cliente sem resposta. `prepend`/sync de histórico antigo → NÃO.
 * Seguro contra replay: `syncFullHistory:false` + idempotência por providerMsgId
 * em registrarMensagemEntrada + a janela de backlog (ver dentroDaJanelaBacklog).
 */
export function deveProcessarUpsert(type: string): boolean {
  return type === "notify" || type === "append";
}

/**
 * Para o backlog ("append"), descarta mensagens mais velhas que `maxIdadeMs`
 * (default 24h) — evita reabrir conversas antigas se o WA entregar histórico.
 * `ts` é o messageTimestamp do Baileys (segundos). Sem timestamp → processa.
 */
export function dentroDaJanelaBacklog(
  ts: number | null | undefined,
  agoraMs: number,
  maxIdadeMs = 86_400_000,
): boolean {
  if (!ts) return true;
  return agoraMs - Number(ts) * 1000 <= maxIdadeMs;
}

/**
 * Detecta um questionário .xlsx anexado. Retorna o documentMessage (com ou sem
 * caption) se o anexo for uma planilha, senão null.
 */
function extrairDocumentoXlsx(m: WAMessage): { fileName: string } | null {
  const doc =
    m.message?.documentMessage ??
    m.message?.documentWithCaptionMessage?.message?.documentMessage;
  if (!doc) return null;
  const mimetype = doc.mimetype ?? "";
  const fileName = doc.fileName ?? "arquivo.xlsx";
  const ehXlsx =
    mimetype.includes("spreadsheetml") ||
    mimetype.includes("ms-excel") ||
    fileName.toLowerCase().endsWith(".xlsx");
  return ehXlsx ? { fileName } : null;
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
    if (!deveProcessarUpsert(type)) return;
    for (const m of messages) {
      try {
        if (m.key.fromMe) continue; // saída — não processamos como entrada
        if (!m.key.remoteJid) continue;
        if (m.key.remoteJid.endsWith("@g.us")) continue; // ignora grupos por enquanto
        // Backlog ("append"): só processa se for recente (janela de 24h).
        if (
          type === "append" &&
          !dentroDaJanelaBacklog(m.messageTimestamp ? Number(m.messageTimestamp) : null, Date.now())
        ) {
          continue;
        }
        const jidRemoto = m.key.remoteJid;
        const enviadaEm = m.messageTimestamp
          ? new Date(Number(m.messageTimestamp) * 1000)
          : undefined;
        // Telefone real (best-effort) quando o jid é @lid; null mantém o fallback.
        const telefoneReal = await resolverTelefoneReal(sock, m, jidRemoto);

        // (A) Questionário .xlsx devolvido pelo cliente → fluxo de formulário.
        const docXlsx = extrairDocumentoXlsx(m);
        if (docXlsx) {
          const registro = await registrarMensagemEntrada({
            canalId,
            jidRemoto,
            texto: `[formulário recebido: ${docXlsx.fileName}]`,
            pushName: m.pushName ?? undefined,
            providerMsgId: m.key.id ?? undefined,
            enviadaEm,
            telefoneReal,
          });
          if (!registro || registro.duplicada) continue;

          const enviarTexto = async (t: string) => {
            await sessionManager.enviarTextoBot({
              canalId,
              conversaId: registro.conversaId,
              jid: jidRemoto,
              texto: t,
            });
          };

          let buffer: Buffer;
          try {
            buffer = (await downloadMediaMessage(
              m,
              "buffer",
              {},
              {
                logger: baileysLoggerSilencioso,
                reuploadRequest: sock.updateMediaMessage,
              },
            )) as Buffer;
          } catch (e) {
            logger.error("[wa.handlers] download do formulário falhou", {
              canalId,
              erro: (e as Error).message,
            });
            await enviarTexto(
              "Não consegui baixar seu arquivo aqui 😕 Pode reenviar, ou me responder por aqui mesmo?",
            ).catch(() => {});
            continue;
          }

          await processarFormularioRecebido({
            canalId,
            conversaId: registro.conversaId,
            jidRemoto,
            documento: buffer,
            enviar: enviarTexto,
          });
          continue;
        }

        // (B) Texto (inclui captions de imagem/vídeo).
        const texto = extrairTexto(m);
        if (!texto) continue; // mídia sem caption diferido para outra fase
        const registro = await registrarMensagemEntrada({
          canalId,
          jidRemoto,
          texto,
          pushName: m.pushName ?? undefined,
          providerMsgId: m.key.id ?? undefined,
          enviadaEm,
          telefoneReal,
        });

        if (!registro || registro.duplicada) continue;

        // Telefone real indisponível (jid @lid sem PN) → pede ao bot perguntar.
        if (isLidUser(jidRemoto) && !telefoneReal) {
          await pedirTelefoneSeNecessario(registro.conversaId);
        }

        // Aciona o agente Bia. Funções `enviar`/`enviarDocumento` injetadas para
        // evitar acoplar o bot.service ao sessionManager (testes podem mockar).
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
          enviarDocumento: async (doc) => {
            await sessionManager.enviarDocumentoBot({
              canalId,
              conversaId: registro.conversaId,
              jid: jidRemoto,
              documento: doc.documento,
              fileName: doc.fileName,
              mimetype: doc.mimetype,
              caption: doc.caption,
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

  // Ack de ENTREGA: o WhatsApp informa o avanço do status das mensagens que
  // ENVIAMOS (fromMe). Mapeamos o WAMessageStatus numérico (2=enviado, 3=entregue,
  // 4=lido, 5=reproduzido) para mensagens.status_entrega — alimenta os checkmarks
  // REAIS na timeline. Best-effort: erros só logam.
  sock.ev.on("messages.update", async (updates) => {
    for (const u of updates) {
      try {
        if (!u.key?.fromMe || !u.key.id) continue; // só nossas mensagens de saída
        const status = u.update?.status;
        if (typeof status !== "number") continue;
        await registrarStatusEntrega(u.key.id, status);
      } catch (e) {
        logger.warn("[wa.handlers] messages.update item falhou", {
          canalId,
          erro: (e as Error).message,
        });
      }
    }
  });
}
