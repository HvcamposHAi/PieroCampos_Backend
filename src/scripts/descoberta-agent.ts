/**
 * AGENTE LOCAL de DESCOBERTA (Playwright na máquina do operador — nunca no Render).
 *
 * Faz POLL de /api/descoberta/agente/trabalho. Para cada job: abre o portal num
 * navegador VISÍVEL e o operador faz login (+2FA/captcha — humano no laço) e roda
 * UMA cotação de TESTE; enquanto isso, capturamos o tráfego HTTP/JSON e o DOM,
 * REDIGIMOS segredos/PII e devolvemos ao backend, que monta a API-Doc + adapter
 * (rascunho, inativo). NUNCA dispara emissão real; é dry-run de descoberta.
 *
 * Rode com `npm run descoberta:agent`. NUNCA imprime credencial/código/token.
 *
 * .env: DESCOBERTA_AGENT_BACKEND_URL, DESCOBERTA_AGENT_TOKEN (mesmo do Render),
 *       DESCOBERTA_ENABLED=true, DESCOBERTA_DWELL_MS (janela de interação),
 *       Supabase (SERVICE_ROLE) e ANTHROPIC_API_KEY (aumento de premissas).
 */
import "dotenv/config";
import axios from "axios";
import { chromium, type Page } from "playwright";
import { capturarPagina } from "../integrations/descoberta/captura/cdp-har.capture";

const BACKEND = (process.env.DESCOBERTA_AGENT_BACKEND_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.DESCOBERTA_AGENT_TOKEN ?? "";
const POLL_MS = Number(process.env.DESCOBERTA_AGENT_POLL_MS ?? 10_000);
const DWELL_MS = Number(process.env.DESCOBERTA_DWELL_MS ?? 120_000);

interface Job {
  id: string;
  corretora_id: string;
  sistema: string;
  ramo: string | null;
  resumo: { url?: string; operacao?: "consulta" | "cotacao" | "apolice"; ramosSuportados?: string[] } | null;
}

const headers = (): Record<string, string> => ({ "x-cron-token": TOKEN });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function pegarTrabalho(): Promise<Job | null> {
  const r = await axios.get(`${BACKEND}/api/descoberta/agente/trabalho`, { headers: headers(), timeout: 90_000 });
  return (r.data?.job as Job | null) ?? null;
}

async function reportar(payload: Record<string, unknown>): Promise<void> {
  await axios
    .post(`${BACKEND}/api/descoberta/agente/reportar`, payload, { headers: headers(), timeout: 120_000 })
    .catch((e) => console.log("reportar falhou:", (e as Error).message));
}

async function processar(job: Job): Promise<void> {
  const url = job.resumo?.url;
  if (!url) {
    await reportar({ jobId: job.id, corretoraId: job.corretora_id, sistema: job.sistema, ramo: job.ramo ?? "auto", erro: "job_sem_url" });
    return;
  }
  const browser = await chromium.launch({ headless: false });
  let exigiu2fa = false;
  try {
    console.log(`\n[descoberta-agent] Abrindo ${url}`);
    console.log(`[descoberta-agent] >>> FAÇA LOGIN e rode UMA cotação de TESTE. Capturando por ${Math.round(DWELL_MS / 1000)}s…`);
    const walkthrough = async (page: Page): Promise<void> => {
      // humano no laço: só observamos. Detecta sinal de 2FA pela URL/markup.
      const ate = Date.now() + DWELL_MS;
      while (Date.now() < ate) {
        const u = page.url();
        if (/otp|mfa|2fa|verificacao|verification|codigo/i.test(u)) exigiu2fa = true;
        await page.waitForTimeout(2_000);
      }
    };
    const { har, markup, piiTrafegada } = await capturarPagina(browser, { url, walkthrough });
    console.log(`[descoberta-agent] capturadas ${har.entradas.length} chamadas; PII trafegada: ${piiTrafegada.join(", ") || "—"}`);
    await reportar({
      jobId: job.id,
      corretoraId: job.corretora_id,
      sistema: job.sistema,
      ramo: job.ramo ?? "auto",
      operacao: job.resumo?.operacao ?? "cotacao",
      har,
      dom: { markup, exigiu2fa },
      ramosSuportados: job.resumo?.ramosSuportados,
      estabilidade: "estavel",
    });
    console.log("[descoberta-agent] reportado. Contrato (rascunho) criado no Admin › Integrações.");
  } catch (e) {
    await reportar({ jobId: job.id, corretoraId: job.corretora_id, sistema: job.sistema, ramo: job.ramo ?? "auto", erro: (e as Error).message });
  } finally {
    await browser.close();
  }
}

async function loop(): Promise<void> {
  if (!BACKEND || !TOKEN) {
    console.error("[descoberta-agent] defina DESCOBERTA_AGENT_BACKEND_URL e DESCOBERTA_AGENT_TOKEN no .env");
    process.exit(1);
  }
  console.log("[descoberta-agent] no ar; aguardando jobs de descoberta…");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const job = await pegarTrabalho();
      if (job) {
        console.log(`[descoberta-agent] job ${job.id} (${job.sistema}/${job.ramo ?? "?"})`);
        await processar(job);
      }
    } catch (e) {
      console.log("[descoberta-agent] poll falhou:", (e as Error).message);
    }
    await sleep(POLL_MS);
  }
}

void loop();
