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
import { cotacaoRouter } from "./integrations/cotacao/routes";
import { segfyRouter } from "./integrations/segfy/credenciais.routes";
import { usuariosRouter } from "./integrations/usuarios/usuarios.routes";
import { agenteRouter } from "./integrations/agente/agente.routes";
import { auditoriaRouter, auditoriaPublicoRouter } from "./integrations/auditoria/auditoria.routes";
import { auditarMutacoes } from "./middlewares/auditoria";
import { sessionManager } from "./integrations/whatsapp/sessionManager";
import { logger } from "./utils/logger";

/**
 * Decide se a Origin pode falar com a API. FRONT_ORIGIN é uma lista separada por
 * vírgula que aceita:
 *   - origem exata: https://piero-broker-assist.humberto-320.workers.dev
 *   - wildcard de subdomínio: *.humberto-320.workers.dev (cobre os PREVIEW
 *     deploys do Cloudflare Workers, cujo host muda a cada versão — ex.:
 *     3eed78fd-piero-broker-assist.humberto-320.workers.dev)
 *   - "*" libera tudo.
 * Sem FRONT_ORIGIN → libera tudo (dev). Requisições sem Origin (curl/healthcheck)
 * passam. A autenticação real é o JWT Supabase (authSupabase), não o CORS.
 */
export function origemPermitida(origin: string | undefined, frontOrigin: string): boolean {
  if (!origin) return true;
  const lista = frontOrigin.split(",").map((o) => o.trim()).filter(Boolean);
  if (lista.length === 0) return true;
  return lista.some((item) => {
    if (item === "*") return true;
    if (item.startsWith("*.")) return origin.endsWith(item.slice(1)); // sufixo c/ o ponto
    return origin === item;
  });
}

export function criarApp(): express.Express {
  const env = getEnv();
  const app = express();

  // Render fica atrás de 1 proxy: sem isto, req.ip traz o IP do proxy (não do
  // cliente) — a trilha de auditoria registraria sempre o mesmo IP interno.
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, origemPermitida(origin, env.FRONT_ORIGIN)),
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

  // Pública (sem JWT): o front reporta tentativas de login que falharam.
  app.use("/api/auditoria/acesso-falho", auditoriaPublicoRouter);

  app.use("/api/wa", authSupabase, auditarMutacoes("whatsapp"), waRouter);
  app.use("/api/cotacao", authSupabase, auditarMutacoes("cotacao"), cotacaoRouter);
  app.use("/api/segfy", authSupabase, auditarMutacoes("segfy"), segfyRouter);
  app.use("/api/usuarios", authSupabase, auditarMutacoes("usuarios"), usuariosRouter);
  app.use("/api/agente", authSupabase, auditarMutacoes("agente"), agenteRouter);
  app.use("/api/auditoria", authSupabase, auditoriaRouter);

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
