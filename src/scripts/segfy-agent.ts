/**
 * AGENTE LOCAL do Segfy (solução gratuita — sem navegador no servidor). Daemon
 * sempre-ligado na máquina do escritório (perfil persistente confiável em
 * ./.segfy-profile). Faz DUAS coisas:
 *
 *  1) COLHEITA periódica (~45min): abre o multicálculo e captura os tokens de
 *     automação, enviando ao backend (POST /api/segfy/sessao/tokens) — mantém a
 *     cotação funcionando sem 2FA enquanto o perfil dos 30 dias é válido.
 *  2) REAUTH 1-clique sob demanda: faz POLL de /api/segfy/sessao/reauth/agente/
 *     trabalho; quando o admin clica "Reautenticar agora" no app, abre o login,
 *     chega no 2FA, avisa o backend ('aguardando_codigo'), recebe o CÓDIGO digitado
 *     no app, aplica + marca "lembrar 30 dias", colhe os tokens e conclui.
 *
 * Rode UMA vez `npm run segfy:perfil` (estabelece o perfil) e deixe este daemon no
 * ar (Task Scheduler no logon). NUNCA imprime código/senha/token.
 *
 *   npm run segfy:agent
 *
 * .env: SEGFY_AGENT_BACKEND_URL (URL do backend), SEGFY_SESSAO_CRON_TOKEN (mesmo do
 *       Render) e Supabase (SUPABASE_URL/SERVICE_ROLE — p/ obter as credenciais).
 */
import "dotenv/config";
import path from "node:path";
import axios from "axios";
import { chromium, type BrowserContext, type Page } from "playwright";
import { obterCredenciaisSegfy } from "../services/segfy-credenciais.service";

const DIR = path.resolve(".segfy-profile");
const LOGIN_URL = "https://login.segfy.com/login";
const HOME_URL = "https://app.segfy.com/home";
const MC_URL = "https://app.segfy.com/multicalculo/hfy-auto";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const SEL_EMAIL = 'input[name="email"], input[type="email"], input[type="text"], input:not([type])';
const SEL_SENHA = 'input[type="password"]';
const SEL_SUBMIT = 'button[type="submit"]';
const SEL_OTP =
  'input[name="code"], input[name="otp"], input[name="token"], input[autocomplete="one-time-code"], input[inputmode="numeric"]';
const SEL_COOKIES = "#hs-eu-confirmation-button, #hs-eu-cookie-confirmation button";

const BACKEND = (process.env.SEGFY_AGENT_BACKEND_URL ?? "").replace(/\/+$/, "");
const CRON_TOKEN = process.env.SEGFY_SESSAO_CRON_TOKEN ?? "";
const POLL_MS = Number(process.env.SEGFY_AGENT_POLL_MS ?? 10_000);
const HARVEST_MS = Number(process.env.SEGFY_AGENT_HARVEST_MS ?? 45 * 60_000);

interface ReauthJob {
  id: string;
  fase: "abrindo" | "aguardando_codigo" | "codigo_enviado" | string;
  codigo?: string | null;
}

const api = () => ({ "x-cron-token": CRON_TOKEN });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pegarTrabalho(): Promise<ReauthJob | null> {
  const r = await axios.get(`${BACKEND}/api/segfy/sessao/reauth/agente/trabalho`, { headers: api(), timeout: 90_000 });
  return (r.data?.job as ReauthJob | null) ?? null;
}
async function reportar(jobId: string, fase: "aguardando_codigo" | "concluida" | "erro", extra: { mensagem?: string; email?: string } = {}): Promise<void> {
  await axios
    .post(`${BACKEND}/api/segfy/sessao/reauth/agente/reportar`, { jobId, fase, ...extra }, { headers: api(), timeout: 90_000 })
    .catch((e) => console.log("reportar falhou:", (e as Error).message));
}
async function enviarTokens(authAutomationToken: string, userAutomationToken: string): Promise<void> {
  const enviar = () =>
    axios.post(`${BACKEND}/api/segfy/sessao/tokens`, { authAutomationToken, userAutomationToken }, { headers: api(), timeout: 90_000 });
  await enviar().catch(async (e) => {
    console.log("envio de tokens: 1ª tentativa falhou (cold start?), repetindo…", (e as Error).message);
    await sleep(5_000);
    return enviar();
  });
}

/** Liga o capturador de tokens numa página (Authorization Bearer + config.token). */
function ligarCaptura(p: Page): { get: () => { auth: string | null; user: string | null } } {
  let auth: string | null = null;
  let user: string | null = null;
  p.on("request", (req) => {
    if (!req.url().includes("api.automation.segfy.com")) return;
    if (!auth) {
      const a = req.headers()["authorization"] ?? "";
      if (a.toLowerCase().startsWith("bearer ")) auth = a.slice(7).trim();
    }
    if (!user) {
      try {
        const pd = req.postData();
        if (pd) {
          const j = JSON.parse(pd) as { config?: { token?: string } };
          if (j.config?.token) user = j.config.token;
        }
      } catch { /* não-json */ }
    }
  });
  return { get: () => ({ auth, user }) };
}

async function abrirLogado(p: Page, url: string): Promise<void> {
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
  for (let i = 0; i < 60; i++) {
    const u = p.url();
    if (u.includes("/login/mfa")) throw new Error("perfil_expirou_2fa");
    if (!u.includes("/login")) return;
    await p.waitForTimeout(500);
  }
  if (p.url().includes("/login")) throw new Error("preso_no_login");
}

/** Abre MC com o perfil confiável e captura os 2 tokens (ou null). */
async function capturarTokens(p: Page): Promise<{ auth: string; user: string } | null> {
  const cap = ligarCaptura(p);
  await abrirLogado(p, HOME_URL);
  await p.waitForTimeout(2_000);
  await abrirLogado(p, MC_URL);
  for (let i = 0; i < 60; i++) {
    const { auth, user } = cap.get();
    if (auth && user) return { auth, user };
    await p.waitForTimeout(500);
  }
  return null;
}

/** COLHEITA periódica (perfil confiável). Retorna true se enviou tokens. */
async function harvest(): Promise<boolean> {
  const ctx = await chromium.launchPersistentContext(DIR, { headless: true, userAgent: UA });
  const p = ctx.pages()[0] ?? (await ctx.newPage());
  try {
    const t = await capturarTokens(p);
    if (!t) {
      console.log("[harvest] não capturei tokens (multicálculo não disparou).");
      return false;
    }
    await enviarTokens(t.auth, t.user);
    console.log("[harvest] tokens renovados no backend ✅");
    return true;
  } catch (e) {
    console.log("[harvest] falhou:", (e as Error).message);
    return false;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

async function dispensarBanner(p: Page): Promise<void> {
  const ok = p.locator(SEL_COOKIES).first();
  if (await ok.isVisible({ timeout: 2_000 }).catch(() => false)) await ok.click().catch(() => undefined);
}

/** REAUTH conduzida pelo app: login → 2FA (código vem do backend) → colhe tokens. */
async function reauth(job: ReauthJob): Promise<void> {
  const creds = await obterCredenciaisSegfy();
  if (!creds) {
    await reportar(job.id, "erro", { mensagem: "Credenciais do Segfy não cadastradas." });
    return;
  }
  const ctx: BrowserContext = await chromium.launchPersistentContext(DIR, { headless: true, userAgent: UA });
  const p = ctx.pages()[0] ?? (await ctx.newPage());
  try {
    await p.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (p.url().includes("/login")) {
      await p.locator(SEL_EMAIL).first().fill(creds.email).catch(() => undefined);
      await p.locator(SEL_SENHA).first().fill(creds.password).catch(() => undefined);
      await dispensarBanner(p);
      await p.locator(SEL_SUBMIT).first().click({ timeout: 8_000 }).catch(async () => {
        await p.locator(SEL_SENHA).first().press("Enter").catch(() => undefined);
      });
    }

    const temOtp = await p.locator(SEL_OTP).first().waitFor({ state: "visible", timeout: 15_000 }).then(() => true).catch(() => false);
    if (temOtp) {
      // Avisa o app que precisa do código e marca "lembrar 30 dias" ANTES (o form
      // auto-submete no 6º dígito). Checkbox custom (input oculto).
      await reportar(job.id, "aguardando_codigo", { email: creds.email });
      const rotulo = p.getByText(/lembrar este dispositivo/i).first();
      if (await rotulo.isVisible({ timeout: 2_500 }).catch(() => false)) await rotulo.click().catch(() => undefined);
      await p.locator('input[type="checkbox"]').first().check({ force: true, timeout: 2_000 }).catch(() => undefined);

      // Espera o admin digitar o código no app (poll do job até ~4min).
      let codigo: string | null = null;
      for (let i = 0; i < 240 && !codigo; i++) {
        const atual = await pegarTrabalho().catch(() => null);
        if (!atual || atual.id !== job.id) { await sleep(1_000); continue; }
        if (atual.fase === "codigo_enviado" && atual.codigo) codigo = atual.codigo;
        else await sleep(1_000);
      }
      if (!codigo) {
        await reportar(job.id, "erro", { mensagem: "Tempo esgotado esperando o código 2FA." });
        return;
      }
      const boxes = p.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"]');
      const n = await boxes.count().catch(() => 0);
      if (n >= codigo.length) {
        await boxes.first().click().catch(() => undefined);
        await p.keyboard.type(codigo, { delay: 60 });
      } else {
        await boxes.first().fill(codigo).catch(() => undefined);
      }
      await p.getByRole("button", { name: /verificar/i }).first().click({ timeout: 5_000 }).catch(() => undefined);
    }

    // Logado = saiu de qualquer tela de /login (a 2FA fica em /login/mfa).
    await p.waitForURL((u) => !u.toString().includes("/login"), { timeout: 30_000 }).catch(() => undefined);
    if (p.url().includes("/login")) {
      await reportar(job.id, "erro", { mensagem: "Código rejeitado ou login não concluiu. Tente de novo." });
      return;
    }

    // Sessão renovada → colhe tokens na hora p/ a cotação voltar imediatamente.
    const t = await capturarTokens(p);
    if (t) await enviarTokens(t.auth, t.user);
    await reportar(job.id, "concluida", { mensagem: t ? "Sessão renovada por 30 dias." : "Sessão renovada (tokens na próxima colheita)." });
    console.log("[reauth] concluída ✅");
  } catch (e) {
    const msg = (e as Error).message === "perfil_expirou_2fa" ? "Perfil expirou — reautenticação necessária." : (e as Error).message;
    await reportar(job.id, "erro", { mensagem: msg });
    console.log("[reauth] falhou:", msg);
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (!BACKEND) throw new Error("Defina SEGFY_AGENT_BACKEND_URL no .env (URL do backend).");
  if (!CRON_TOKEN) throw new Error("Defina SEGFY_SESSAO_CRON_TOKEN no .env (mesmo do Render).");
  console.log("== Agente Segfy no ar ==");
  console.log("Backend:", BACKEND, "| poll:", POLL_MS, "ms | harvest:", Math.round(HARVEST_MS / 60_000), "min");

  let proximoHarvest = 0; // colhe já na 1ª volta
  // Loop infinito: prioriza reauth on-demand; intercala colheita periódica.
  for (;;) {
    try {
      const job = await pegarTrabalho().catch((e) => {
        console.log("poll trabalho falhou:", (e as Error).message);
        return null;
      });
      if (job && job.fase === "abrindo") {
        console.log("[reauth] pedido recebido — abrindo o Segfy…");
        await reauth(job);
        proximoHarvest = Date.now() + HARVEST_MS; // acabou de renovar
      } else if (Date.now() >= proximoHarvest) {
        await harvest();
        proximoHarvest = Date.now() + HARVEST_MS;
      }
    } catch (e) {
      console.log("loop:", (e as Error).message);
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => {
  console.error("❌ Agente parou:", (e as Error).message);
  process.exit(1);
});
