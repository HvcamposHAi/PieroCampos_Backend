/**
 * Entry point do backend. Substitui o stub index.js (16 linhas).
 *
 * Validar env é a 1ª coisa (getEnv() lança se faltar segredo); só depois
 * monta o Express e abre os sockets Baileys.
 */
import { criarApp } from "./app";
import { getEnv } from "./config/env";
import { logger } from "./utils/logger";

function main(): void {
  const env = getEnv();
  const app = criarApp();
  app.listen(env.PORT, () => {
    logger.info("[index] backend ouvindo", {
      porta: env.PORT,
      wa_enabled: env.WA_ENABLED,
      segfy_enabled: env.SEGFY_ENABLED,
    });
  });
}

main();
