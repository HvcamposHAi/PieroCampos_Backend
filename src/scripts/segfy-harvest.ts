/**
 * AGENTE LOCAL DE COLHEITA (solução gratuita — sem navegador no servidor).
 *
 * Roda na máquina do operador (perfil persistente confiável em ./.segfy-profile),
 * abre o multicálculo Auto, captura os tokens de automação que o app usa
 * (Authorization Bearer = authAutomationToken; body config.token = userAutomationToken)
 * e os ENVIA ao backend (POST /api/segfy/sessao/tokens, header x-cron-token).
 * O backend (Render Free, sem navegador) passa a usar esses tokens nas cotações.
 *
 * Agende a cada ~45min (Windows Task Scheduler). Faça `npm run segfy:perfil` uma
 * vez (2FA + lembrar 30 dias) antes. NUNCA imprime valores de token.
 *
 *   npm run segfy:harvest
 *
 * .env: SEGFY_SESSAO_CRON_TOKEN (mesmo do Render) e SEGFY_AGENT_BACKEND_URL
 *       (URL do backend no Render). WA_ENABLED/BIA_ENABLED podem ficar false.
 */
import "dotenv/config";
import path from "node:path";
import axios from "axios";
import { chromium } from "playwright";

const DIR = path.resolve(".segfy-profile");
const MC_URL = "https://app.segfy.com/multicalculo/hfy-auto";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const BACKEND = (process.env.SEGFY_AGENT_BACKEND_URL ?? "").replace(/\/+$/, "");
const CRON_TOKEN = process.env.SEGFY_SESSAO_CRON_TOKEN ?? "";

async function main(): Promise<void> {
  if (!BACKEND) throw new Error("Defina SEGFY_AGENT_BACKEND_URL no .env (URL do backend).");
  if (!CRON_TOKEN) throw new Error("Defina SEGFY_SESSAO_CRON_TOKEN no .env (mesmo do Render).");

  const ctx = await chromium.launchPersistentContext(DIR, { headless: true, userAgent: UA });
  const p = ctx.pages()[0] ?? (await ctx.newPage());

  let authAutomationToken: string | null = null;
  let userAutomationToken: string | null = null;

  p.on("request", (req) => {
    if (!req.url().includes("api.automation.segfy.com")) return;
    if (!authAutomationToken) {
      const auth = req.headers()["authorization"] ?? "";
      if (auth.toLowerCase().startsWith("bearer ")) authAutomationToken = auth.slice(7).trim();
    }
    if (!userAutomationToken) {
      try {
        const pd = req.postData();
        if (pd) {
          const j = JSON.parse(pd) as { config?: { token?: string } };
          if (j.config?.token) userAutomationToken = j.config.token;
        }
      } catch { /* não-json */ }
    }
  });

  // Abre uma URL e espera o auto-relogin do perfil confiável SAIR do /login.
  // Distingue /login/mfa (trust expirou → precisa 2FA) de /login transitório.
  async function abrirLogado(url: string): Promise<void> {
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((e) => console.log("goto:", (e as Error).message));
    for (let i = 0; i < 60; i++) {
      const u = p.url();
      if (u.includes("/login/mfa")) throw new Error("Perfil expirou (2FA). Rode `npm run segfy:perfil` para reautenticar.");
      if (!u.includes("/login")) return; // logado
      await p.waitForTimeout(500);
    }
    if (p.url().includes("/login")) throw new Error("Ficou preso no /login (auto-relogin não concluiu).");
  }

  try {
    console.log("Carregando /home (bootstrap + auto-relogin)…");
    await abrirLogado("https://app.segfy.com/home");
    await p.waitForTimeout(2_000);
    console.log("Abrindo o multicálculo (perfil confiável)…");
    await abrirLogado(MC_URL);

    // Aguarda até capturar os dois tokens (ou timeout ~30s).
    for (let i = 0; i < 60 && !(authAutomationToken && userAutomationToken); i++) {
      await p.waitForTimeout(500);
    }
  } finally {
    await ctx.close().catch(() => undefined);
  }
  if (!authAutomationToken || !userAutomationToken) {
    throw new Error("Não capturei os tokens (o multicálculo não disparou as chamadas). Tente de novo.");
  }

  console.log("Tokens capturados ✅ — enviando ao backend…");
  // Render Free hiberna: o 1º POST pode acordar o serviço (cold start ~1min).
  // Timeout generoso + 1 retry.
  const enviar = () =>
    axios.post(
      `${BACKEND}/api/segfy/sessao/tokens`,
      { authAutomationToken, userAutomationToken },
      { headers: { "x-cron-token": CRON_TOKEN }, timeout: 90_000 },
    );
  const r = await enviar().catch(async (e) => {
    console.log("1ª tentativa falhou (cold start?), repetindo em 5s…", (e as Error).message);
    await new Promise((res) => setTimeout(res, 5_000));
    return enviar();
  });
  console.log("Backend respondeu:", r.status, JSON.stringify(r.data));
  console.log("🎉 Sessão de cotação renovada no backend.");
}

main().catch((e) => {
  console.error("❌ Falhou:", (e as Error).message);
  process.exit(1);
});
