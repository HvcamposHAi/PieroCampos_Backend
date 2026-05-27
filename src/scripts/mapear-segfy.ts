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

const SAIDA = resolve(__dirname, "../integrations/segfy/endpoints-mapeados.json");
const MAX_AMOSTRA = 4_000; // limita o tamanho do corpo de resposta salvo

async function main(): Promise<void> {
  const env = getEnv();
  const chamadas: ChamadaMapeada[] = [];

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

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

  logger.info("Mapeamento aberto. Faça login e execute as operações no navegador.");
  logger.info("Pressione Ctrl+C para salvar e sair.", { saida: SAIDA });

  const salvar = async () => {
    await writeFile(SAIDA, JSON.stringify({ capturadoEm: new Date().toISOString(), chamadas }, null, 2), "utf8");
    logger.info("Mapa salvo", { total: chamadas.length, saida: SAIDA });
    await browser.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void salvar());
}

void main().catch((e) => {
  logger.error("Falha no mapeamento", { mensagem: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
