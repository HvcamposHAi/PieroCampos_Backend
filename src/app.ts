/**
 * Express app — monta middlewares globais, rotas e dispara o bootstrap dos
 * sockets Baileys.
 *
 * O servidor responde 503 em /health enquanto bootstrap() ainda não terminou,
 * para não receber tráfego de produção com sockets ainda fechados.
 */
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { getEnv } from "./config/env";
import { authSupabase } from "./middlewares/authSupabase";
import { waRouter } from "./integrations/whatsapp/routes";
import { sessionManager } from "./integrations/whatsapp/sessionManager";
import { logger } from "./utils/logger";

export function criarApp(): express.Express {
  const env = getEnv();
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.FRONT_ORIGIN ? env.FRONT_ORIGIN.split(",").map((o) => o.trim()) : "*",
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "256kb" }));

  // Keep-alive: SEMPRE 200, independente do bootstrap. Um pinger externo
  // (UptimeRobot/cron) bate aqui p/ manter o Render Free acordado sem ser
  // enganado pelo gate 503 do /health. Público e fora de /api/wa.
  app.get("/ping", (_req, res) => {
    res.status(200).json({ ok: true, ts: Date.now() });
  });

  let bootstrapPronto = false;
  app.get("/health", (_req, res) => {
    if (!bootstrapPronto) {
      res.status(503).json({ status: "iniciando", bootstrap_pronto: false });
      return;
    }
    res.json({ status: "ok", service: "PieroCampos Backend", bootstrap_pronto: true });
  });

  app.use("/api/wa", authSupabase, waRouter);

  app.use((_req, res) => {
    res.status(404).json({ erro: "rota_nao_encontrada" });
  });

  if (env.WA_ENABLED) {
    sessionManager
      .bootstrap()
      .then(() => {
        bootstrapPronto = true;
        logger.info("[app] bootstrap WhatsApp concluído");
      })
      .catch((e) => {
        logger.error("[app] bootstrap WhatsApp falhou", { erro: (e as Error).message });
        // mantém bootstrapPronto = false; /health continua 503 até intervenção.
      });
  } else {
    bootstrapPronto = true;
    logger.warn("[app] WA_ENABLED=false — sockets Baileys NÃO serão abertos");
  }

  return app;
}
