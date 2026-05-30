/**
 * Entry point do backend. Substitui o stub index.js (16 linhas).
 *
 * Validar env é a 1ª coisa (getEnv() lança se faltar segredo); só depois
 * monta o Express e abre os sockets Baileys.
 *
 * Em SIGTERM/SIGINT (o Render manda SIGTERM antes de hibernar), encerramos os
 * sockets e marcamos os canais como `desconectado` — senão a tela mostra
 * `conectado` stale enquanto o processo dormiu.
 */
import type { Server } from "http";
import { criarApp } from "./app";
import { getEnv } from "./config/env";
import { sessionManager } from "./integrations/whatsapp/sessionManager";
import { logger } from "./utils/logger";

/** Limite p/ o shutdown não travar o exit caso o Supabase esteja lento. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

function registrarShutdown(server: Server): void {
  let encerrando = false;
  const encerrar = (sinal: string): void => {
    if (encerrando) return;
    encerrando = true;
    logger.info("[index] sinal recebido; encerrando", { sinal });
    const limite = setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS);
    sessionManager
      .shutdown(sinal === "SIGTERM" ? "hibernate" : "shutdown")
      .catch((e) => logger.error("[index] shutdown falhou", { erro: (e as Error).message }))
      .finally(() => {
        clearTimeout(limite);
        server.close(() => process.exit(0));
      });
  };
  process.on("SIGTERM", () => encerrar("SIGTERM"));
  process.on("SIGINT", () => encerrar("SIGINT"));
}

function main(): void {
  const env = getEnv();
  const app = criarApp();
  const server = app.listen(env.PORT, () => {
    logger.info("[index] backend ouvindo", {
      porta: env.PORT,
      wa_enabled: env.WA_ENABLED,
      segfy_enabled: env.SEGFY_ENABLED,
    });
  });
  registrarShutdown(server);
}

main();
