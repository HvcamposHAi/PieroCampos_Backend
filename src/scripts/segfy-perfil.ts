/**
 * VALIDAÇÃO da hipótese do PERFIL PERSISTENTE (userDataDir) para contornar o 2FA.
 *
 * O "lembrar 30 dias" do Segfy vive no IndexedDB do navegador, que o storageState
 * NÃO captura — mas um userDataDir (perfil persistente) guarda. Este script:
 *   1) abre um perfil persistente em ./.segfy-profile, loga e passa o 2FA (você
 *      digita o código no terminal), marcando "lembrar 30 dias";
 *   2) FECHA e REABRE o MESMO perfil (simula um restart do servidor) e tenta abrir
 *      app.segfy.com — se entrar SEM 2FA, a hipótese está confirmada.
 *
 *   npm run segfy:perfil
 *
 * A pasta ./.segfy-profile é LOCAL (não versionar). NUNCA loga código/senha/token.
 */
import "dotenv/config";
import readline from "node:readline";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { obterCredenciaisSegfy } from "../services/segfy-credenciais.service";

const DIR = path.resolve(".segfy-profile");
const LOGIN_URL = "https://login.segfy.com/login";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const SEL_EMAIL = 'input[name="email"], input[type="email"], input[type="text"], input:not([type])';
const SEL_SENHA = 'input[type="password"]';
const SEL_SUBMIT = 'button[type="submit"]';
const SEL_OTP =
  'input[name="code"], input[name="otp"], input[name="token"], input[autocomplete="one-time-code"], input[inputmode="numeric"]';
const SEL_COOKIES = "#hs-eu-confirmation-button, #hs-eu-cookie-confirmation button";

function pergunta(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a.trim()); }));
}

async function dispensarBanner(p: Page): Promise<void> {
  const ok = p.locator(SEL_COOKIES).first();
  if (await ok.isVisible({ timeout: 2_000 }).catch(() => false)) await ok.click().catch(() => undefined);
}
async function submeter(p: Page): Promise<void> {
  await p.locator(SEL_SUBMIT).first().click({ timeout: 8_000 }).catch(async () => {
    await p.locator(SEL_SENHA).first().press("Enter").catch(() => undefined);
  });
}

async function login(): Promise<void> {
  const creds = await obterCredenciaisSegfy();
  if (!creds) throw new Error("Sem credenciais Segfy.");
  const ctx = await chromium.launchPersistentContext(DIR, { headless: false, userAgent: UA });
  const p = ctx.pages()[0] ?? (await ctx.newPage());
  try {
    await p.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: 45_000 });
    if (!p.url().includes("login.segfy.com")) {
      console.log("Perfil já confiável — entrou sem formulário:", p.url());
      return;
    }
    await p.locator(SEL_EMAIL).first().fill(creds.email);
    await p.locator(SEL_SENHA).first().fill(creds.password);
    await dispensarBanner(p);
    await submeter(p);

    const temOtp = await p.locator(SEL_OTP).first().waitFor({ state: "visible", timeout: 12_000 }).then(() => true).catch(() => false);
    if (temOtp) {
      console.log("📧 2FA solicitado — verifique o e-mail.");
      const codigo = await pergunta("Digite o código 2FA: ");
      await p.locator(SEL_OTP).first().fill(codigo);
      // marca "Lembrar este dispositivo por 30 dias" — checkbox CUSTOM (input oculto):
      // clica o rótulo e força o check, confirmando o estado.
      const rotulo = p.getByText(/lembrar este dispositivo/i).first();
      if (await rotulo.isVisible({ timeout: 2_500 }).catch(() => false)) {
        await rotulo.click().catch(() => undefined);
      }
      const chk = p.locator('input[type="checkbox"]').first();
      await chk.check({ force: true, timeout: 2_000 }).catch(() => undefined);
      const marcado = await chk.isChecked().catch(() => false);
      console.log(marcado ? '✅ "Lembrar 30 dias" MARCADO.' : '⚠️ Não consegui confirmar o "lembrar 30 dias".');
      await dispensarBanner(p);
      await submeter(p);
    }
    await p.waitForURL((u) => !u.toString().includes("login.segfy.com"), { timeout: 30_000 });
    console.log("✅ Login concluído:", p.url());
  } finally {
    await ctx.close();
  }
}

async function check(): Promise<void> {
  const ctx: BrowserContext = await chromium.launchPersistentContext(DIR, { headless: true, userAgent: UA });
  const p = ctx.pages()[0] ?? (await ctx.newPage());
  try {
    await p.goto("https://app.segfy.com/home", { waitUntil: "networkidle", timeout: 45_000 }).catch((e) => console.log("goto:", (e as Error).message));
    await p.waitForTimeout(4_000);
    const url = p.url();
    console.log("CHECK — URL final:", url);
    if (url.includes("/login")) {
      console.log("❌ Pediu login/2FA de novo — o perfil persistente NÃO carregou o device-trust.");
    } else {
      console.log("🎉 Logado SEM 2FA ao reabrir o MESMO perfil — perfil persistente CARREGA o device-trust dos 30 dias!");
    }
  } finally {
    await ctx.close();
  }
}

async function main(): Promise<void> {
  console.log("== Segfy perfil persistente (validação) ==");
  console.log("Perfil em:", DIR, "\n");
  await login();
  console.log("\n--- Reabrindo o MESMO perfil (simula restart do servidor) ---");
  await check();
}

main().catch((e) => {
  console.error("❌ Falhou:", (e as Error).message);
  process.exit(1);
});
