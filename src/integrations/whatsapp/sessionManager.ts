/**
 * SessionManager — orquestra os sockets Baileys por canal.
 *
 * Estado em memória do processo: 1 socket por canal_id. Persistência (creds,
 * status, mensagens) vive no Supabase, então perder o processo é recuperável
 * via bootstrap().
 *
 * NÃO é seguro para múltiplas instâncias do backend rodando em paralelo
 * (cada uma abriria sockets duplicados → loop de connectionReplaced). Render
 * Starter roda 1 instância — assumimos isso. Ver §5.R9 do plano.
 */
import type { WASocket } from "@whiskeysockets/baileys";
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import { criarSocketBaileys } from "./baileys.client";
import { registrarHandlers } from "./eventHandlers";
import {
  atualizarCanal,
  buscarCanal,
  lerCanaisParaBootstrap,
  registrarMensagemSaida,
  registrarMensagemSaidaBot,
  registrarMensagemSaidaBotDocumento,
} from "./persistence";
import { useSupabaseAuthState } from "./supabaseAuthState";

interface SessionEntry {
  canalId: string;
  apelido: string;
  sock: WASocket;
  fechandoIntencional: boolean;
}

/** Máximo de tentativas de reconexão antes de marcar a linha como `erro`. */
const MAX_RECONNECT = 3;

class SessionManager {
  private sessoes = new Map<string, SessionEntry>();
  /** Contador de tentativas de reconexão por canal. Zera ao conectar com sucesso ou em connect manual. */
  private reconnectAttempts = new Map<string, number>();
  private bootstrapPromise: Promise<void> | null = null;

  /** Idempotente: se já há socket vivo, no-op. */
  async connect(canalId: string): Promise<{ status: string; jaAtivo: boolean }> {
    const existente = this.sessoes.get(canalId);
    if (existente) {
      logger.info("[wa.session] connect chamado mas socket já existe", { canalId });
      return { status: "ja_ativo", jaAtivo: true };
    }

    const canal = await buscarCanal(canalId);
    if (!canal) throw new Error(`canal ${canalId} não encontrado`);
    if (canal.provider !== "baileys") {
      throw new Error(`canal ${canalId} provider=${canal.provider}; só Baileys suporta connect`);
    }

    await atualizarCanal(canalId, { status: "conectando" });

    const { state, saveCreds } = await useSupabaseAuthState(canalId);
    const sock = await criarSocketBaileys({ state, apelidoCanal: canal.apelido });

    const entry: SessionEntry = { canalId, apelido: canal.apelido, sock, fechandoIntencional: false };
    this.sessoes.set(canalId, entry);

    registrarHandlers(canalId, sock, saveCreds, {
      onAberto: () => {
        // Conectou — zera contador para futuras desconexões.
        this.reconnectAttempts.delete(canalId);
      },
      onFechado: (motivo, reconectavel) => {
        this.sessoes.delete(canalId);
        if (entry.fechandoIntencional || !reconectavel) {
          this.reconnectAttempts.delete(canalId);
          return;
        }

        const attempts = (this.reconnectAttempts.get(canalId) ?? 0) + 1;
        this.reconnectAttempts.set(canalId, attempts);

        if (attempts > MAX_RECONNECT) {
          logger.error("[wa.session] limite de reconexões atingido — marcando como erro", {
            canalId,
            tentativas: attempts,
            motivo,
          });
          this.reconnectAttempts.delete(canalId);
          atualizarCanal(canalId, {
            status: "erro",
            qr_code: null,
            qr_expires_at: null,
            last_disconnect_reason: `max_reconnect_${motivo}`,
          }).catch(() => {
            // canal pode ter sido apagado; ignorar
          });
          return;
        }

        const backoff = getEnv().WA_RECONNECT_BACKOFF_MS * attempts; // backoff linear: 5s, 10s, 15s
        logger.info("[wa.session] agendando reconexão", { canalId, motivo, tentativa: attempts, em_ms: backoff });
        setTimeout(() => {
          this.reconectarSeguro(canalId);
        }, backoff);
      },
    });

    return { status: "conectando", jaAtivo: false };
  }

  /**
   * Tentativa de reconexão chamada pelo timer do onFechado.
   * Se o canal foi apagado entretanto, para silenciosamente sem throw.
   */
  private async reconectarSeguro(canalId: string): Promise<void> {
    try {
      const canal = await buscarCanal(canalId);
      if (!canal) {
        logger.warn("[wa.session] reconnect abortado — canal foi apagado", { canalId });
        this.reconnectAttempts.delete(canalId);
        return;
      }
      await this.connect(canalId);
    } catch (e) {
      logger.error("[wa.session] reconnect falhou", {
        canalId,
        erro: (e as Error).message,
      });
    }
  }

  /** Derruba o socket. `logout=true` faz signOff no servidor + apaga auth_state. */
  async disconnect(canalId: string, opts: { logout?: boolean } = {}): Promise<void> {
    const entry = this.sessoes.get(canalId);
    if (!entry) {
      logger.info("[wa.session] disconnect sem socket vivo (limpando status)", { canalId });
      await atualizarCanal(canalId, {
        status: "desconectado",
        qr_code: null,
        qr_expires_at: null,
        last_disconnect_reason: opts.logout ? "logout_manual" : "disconnect_manual",
      });
      return;
    }
    entry.fechandoIntencional = true;
    try {
      if (opts.logout) await entry.sock.logout();
      else entry.sock.end(undefined);
    } catch (e) {
      logger.warn("[wa.session] erro ao encerrar socket", {
        canalId,
        erro: (e as Error).message,
      });
    }
    this.sessoes.delete(canalId);
    await atualizarCanal(canalId, {
      status: "desconectado",
      qr_code: null,
      qr_expires_at: null,
      last_disconnect_reason: opts.logout ? "logout_manual" : "disconnect_manual",
    });
  }

  get(canalId: string): SessionEntry | undefined {
    return this.sessoes.get(canalId);
  }

  /** Envia texto via canal conectado. Persiste mensagem em `mensagens`. */
  async enviarTexto(input: {
    canalId: string;
    conversaId: string;
    jid: string;
    texto: string;
    operadorNome?: string;
  }): Promise<{ messageId: string }> {
    const entry = this.sessoes.get(input.canalId);
    if (!entry) throw new Error(`canal ${input.canalId} não conectado`);
    const canal = await buscarCanal(input.canalId);
    if (!canal || canal.status !== "conectado") {
      throw new Error(`canal ${input.canalId} status=${canal?.status ?? "?"} (precisa estar conectado)`);
    }
    const resultado = await entry.sock.sendMessage(input.jid, { text: input.texto });
    const messageId = resultado?.key?.id ?? "";
    await registrarMensagemSaida({
      canalId: input.canalId,
      conversaId: input.conversaId,
      texto: input.texto,
      providerMsgId: messageId,
      operadorNome: input.operadorNome,
    });
    return { messageId };
  }

  /**
   * Variante para o agente Bia: persiste com `origem='bot'`. Idem precondições.
   * Usada pelo bot.service. Em rotas HTTP de operador, use `enviarTexto`.
   */
  async enviarTextoBot(input: {
    canalId: string;
    conversaId: string;
    jid: string;
    texto: string;
  }): Promise<{ messageId: string }> {
    const entry = this.sessoes.get(input.canalId);
    if (!entry) throw new Error(`canal ${input.canalId} não conectado`);
    const canal = await buscarCanal(input.canalId);
    if (!canal || canal.status !== "conectado") {
      throw new Error(`canal ${input.canalId} status=${canal?.status ?? "?"} (precisa estar conectado)`);
    }
    const resultado = await entry.sock.sendMessage(input.jid, { text: input.texto });
    const messageId = resultado?.key?.id ?? "";
    await registrarMensagemSaidaBot({
      canalId: input.canalId,
      conversaId: input.conversaId,
      texto: input.texto,
      providerMsgId: messageId,
    });
    return { messageId };
  }

  /**
   * Envia um DOCUMENTO (buffer em memória) pela Bia: usado para o questionário
   * .xlsx. Mesmas precondições de `enviarTextoBot`. Persiste com `midia_tipo`.
   */
  async enviarDocumentoBot(input: {
    canalId: string;
    conversaId: string;
    jid: string;
    documento: Buffer;
    fileName: string;
    mimetype: string;
    caption?: string;
  }): Promise<{ messageId: string }> {
    const entry = this.sessoes.get(input.canalId);
    if (!entry) throw new Error(`canal ${input.canalId} não conectado`);
    const canal = await buscarCanal(input.canalId);
    if (!canal || canal.status !== "conectado") {
      throw new Error(`canal ${input.canalId} status=${canal?.status ?? "?"} (precisa estar conectado)`);
    }
    const resultado = await entry.sock.sendMessage(input.jid, {
      document: input.documento,
      fileName: input.fileName,
      mimetype: input.mimetype,
      caption: input.caption,
    });
    const messageId = resultado?.key?.id ?? "";
    await registrarMensagemSaidaBotDocumento({
      canalId: input.canalId,
      conversaId: input.conversaId,
      descricao: input.caption ?? `[documento: ${input.fileName}]`,
      midiaTipo: "document",
      providerMsgId: messageId,
    });
    return { messageId };
  }

  /**
   * Reabre sockets de canais que tinham auth_state salvo. Chamado uma vez no
   * boot do servidor. Idempotente: chamadas subsequentes resolvem na 1ª.
   */
  async bootstrap(): Promise<void> {
    if (this.bootstrapPromise) return this.bootstrapPromise;
    this.bootstrapPromise = (async () => {
      const canais = await lerCanaisParaBootstrap();
      logger.info("[wa.session] bootstrap iniciando", { quantidade: canais.length });
      for (const canal of canais) {
        try {
          await this.connect(canal.id);
        } catch (e) {
          logger.error("[wa.session] reabertura falhou", {
            canalId: canal.id,
            erro: (e as Error).message,
          });
        }
      }
      logger.info("[wa.session] bootstrap concluído");
    })();
    return this.bootstrapPromise;
  }

  bootstrapEmAndamento(): boolean {
    return this.bootstrapPromise !== null && this.sessoes.size === 0;
  }
}

export const sessionManager = new SessionManager();
