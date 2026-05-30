/**
 * Mapeamento de endpoints Segfy (GATE do Sprint B).
 *
 * Abre o navegador (headful), você loga MANUALMENTE na SPA com a conta
 * comercial1@pierodecampos.com.br e executa as operações (criar segurado,
 * cotar, criar proposta, registrar apólice). O script intercepta cada chamada
 * XHR/Fetch e, ao encerrar (Ctrl+C), grava o mapa em
 * src/integrations/segfy/endpoints-mapeados.json.
 *
 * Headers sensíveis (Authorization, Cookie) são REDIGIDOS no arquivo.
 * Uso: npm run segfy:mapear
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { getEnv } from "../config/env";
import { logger, redigir } from "../utils/logger";

interface ChamadaMapeada {
  method: string;
  url: string;
  resourceType: string;
  requestHeaders: unknown;
  requestBody?: string;
  status?: number;
  responseSample?: string;
}

/** Frames de WebSocket — é por aqui que os RESULTADOS por seguradora chegam
 * (o multicálculo é assíncrono via `callback`). */
interface WsFrame {
  ws: string;
  dir: "recv" | "sent";
  amostra: string;
}

const SAIDA = resolve(__dirname, "../integrations/segfy/endpoints-mapeados.json");
const MAX_AMOSTRA = 4_000; // limita o tamanho do corpo de resposta salvo

async function main(): Promise<void> {
  const env = getEnv();
  const chamadas: ChamadaMapeada[] = [];
  const wsFrames: WsFrame[] = [];

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Captura WebSocket (resultados assíncronos por seguradora). Limita o volume
  // e o tamanho de cada frame para o arquivo não explodir.
  page.on("websocket", (ws) => {
    const guardar = (dir: "recv" | "sent") => (data: string | Buffer) => {
      if (wsFrames.length > 400) return;
      const s = typeof data === "string" ? data : `<binary:${data.length}>`;
      wsFrames.push({ ws: ws.url(), dir, amostra: s.slice(0, MAX_AMOSTRA) });
    };
    ws.on("framereceived", (e) => guardar("recv")(e.payload));
    ws.on("framesent", (e) => guardar("sent")(e.payload));
  });

  page.on("request", (req) => {
    const tipo = req.resourceType();
    if (tipo !== "xhr" && tipo !== "fetch") return;
    chamadas.push({
      method: req.method(),
      url: req.url(),
      resourceType: tipo,
      requestHeaders: redigir(req.headers()),
      requestBody: req.postData() ?? undefined,
    });
  });

  page.on("response", async (resp) => {
    const tipo = resp.request().resourceType();
    if (tipo !== "xhr" && tipo !== "fetch") return;
    const reg = chamadas.find((c) => c.url === resp.url() && c.status === undefined);
    if (!reg) return;
    reg.status = resp.status();
    try {
      const txt = await resp.text();
      reg.responseSample = txt.slice(0, MAX_AMOSTRA);
    } catch {
      /* corpos binários/streamed são ignorados */
    }
  });

  const url = `${env.SEGFY_APP_URL.replace(/\/+$/, "")}/login`;
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // Login automático (seletores confirmados em 29/05/2026): o campo de e-mail do
  // SSO é um <input> sem type/name; submeter via Enter (o botão fica coberto pelo
  // widget de chat). Se já houver 2FA (após 01/06), o fluxo pausa aqui.
  try {
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    await page.locator("input:not([type=password])").first().fill(env.SEGFY_LOGIN);
    await page.locator('input[type="password"]').first().fill(env.SEGFY_SENHA);
    await page.locator('input[type="password"]').first().press("Enter");
    await page.waitForURL(
      (u) => u.href.includes("app.segfy.com") && !u.href.includes("login.segfy.com"),
      { timeout: 25_000 },
    );
    logger.info("Login automático OK.");
  } catch {
    logger.warn("Login automático falhou (2FA? credencial?). Faça login manualmente no navegador.");
  }

  logger.info("👉 Agora, NO NAVEGADOR: HFy → Auto → preencha e DISPARE 1 cotação.");
  logger.info("   (dispense os popups de extensão/NPS/cookies). Capturo XHR + WebSocket.");
  logger.info("   ⏳ IMPORTANTE: AGUARDE os PREÇOS das seguradoras aparecerem na tela");
  logger.info("      (pode levar 1-3 min) ANTES de sair — é por WebSocket que vêm os resultados.");
  logger.info("Quando os preços tiverem carregado, pressione Ctrl+C aqui para salvar.", { saida: SAIDA });

  const salvar = async () => {
    await writeFile(
      SAIDA,
      JSON.stringify({ capturadoEm: new Date().toISOString(), chamadas, wsFrames }, null, 2),
      "utf8",
    );
    logger.info("Mapa salvo", { total: chamadas.length, wsFrames: wsFrames.length, saida: SAIDA });
    await browser.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void salvar());
}

void main().catch((e) => {
  logger.error("Falha no mapeamento", { mensagem: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
