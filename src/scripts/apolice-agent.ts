/**
 * AGENTE LOCAL de APÓLICE (sem navegador no servidor — corrige o erro de Chromium
 * no Render). Daemon na máquina do operador: faz POLL de /api/apolice/agente/
 * trabalho e, para cada job, RODA LOCALMENTE os serviços que já existem
 * (`testarConectividade` p/ 'testar', `emitirApolice` p/ 'emitir') — o navegador
 * Playwright sobe AQUI — e reporta o fim ao backend (que é só o corretor de jobs).
 *
 * Rode com `npm run apolice:agent` (Task Scheduler no logon). NUNCA imprime
 * credencial/código/token.
 *
 * .env: APOLICE_AGENT_BACKEND_URL (URL do backend), APOLICE_AGENT_TOKEN (mesmo do
 *       Render), APOLICE_RPA_ENABLED=true, Supabase (SERVICE_ROLE), WA_AUTH_ENCRYPTION_KEY
 *       (a MESMA do Render p/ decifrar as credenciais) e ANTHROPIC_API_KEY (driver-LLM).
 */
import "dotenv/config";
import axios from "axios";
import { testarConectividade } from "../services/seguradoras-config.service";
import { emitirApolice } from "../services/apolice-emissao.service";

const BACKEND = (process.env.APOLICE_AGENT_BACKEND_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.APOLICE_AGENT_TOKEN ?? "";
const POLL_MS = Number(process.env.APOLICE_AGENT_POLL_MS ?? 10_000);

interface Job {
  id: string;
  corretora_id: string;
  tipo: "testar" | "emitir";
  seguradora_config_id: string | null;
  proposta_id: string | null;
}

const headers = () => ({ "x-cron-token": TOKEN });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pegarTrabalho(): Promise<Job | null> {
  const r = await axios.get(`${BACKEND}/api/apolice/agente/trabalho`, { headers: headers(), timeout: 90_000 });
  return (r.data?.job as Job | null) ?? null;
}

async function reportar(
  jobId: string,
  fase: "concluida" | "erro",
  resultado: Record<string, unknown> | null,
  mensagem?: string,
): Promise<void> {
  await axios
    .post(`${BACKEND}/api/apolice/agente/reportar`, { jobId, fase, resultado, mensagem }, { headers: headers(), timeout: 90_000 })
    .catch((e) => console.log("reportar falhou:", (e as Error).message));
}

async function processar(job: Job): Promise<void> {
  try {
    if (job.tipo === "testar" && job.seguradora_config_id) {
      const r = await testarConectividade(job.corretora_id, job.seguradora_config_id);
      await reportar(job.id, "concluida", { ok: r.ok, status_acesso: r.status_acesso }, r.mensagem);
    } else if (job.tipo === "emitir" && job.proposta_id) {
      const r = await emitirApolice({ propostaId: job.proposta_id, corretoraId: job.corretora_id });
      if ("apoliceId" in r) await reportar(job.id, "concluida", { apoliceId: r.apoliceId });
      else await reportar(job.id, "erro", { erro: r.erro }, `Emissão falhou: ${r.erro}`);
    } else {
      await reportar(job.id, "erro", { erro: "job_invalido" }, "Job sem alvo válido.");
    }
  } catch (e) {
    await reportar(job.id, "erro", { erro: "excecao" }, (e as Error).message);
  }
}

async function loop(): Promise<void> {
  if (!BACKEND || !TOKEN) {
    console.error("[apolice-agent] defina APOLICE_AGENT_BACKEND_URL e APOLICE_AGENT_TOKEN no .env");
    process.exit(1);
  }
  console.log("[apolice-agent] no ar; aguardando jobs de apólice…");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const job = await pegarTrabalho();
      if (job) {
        console.log(`[apolice-agent] job ${job.tipo} ${job.id}`);
        await processar(job);
      }
    } catch (e) {
      console.log("[apolice-agent] poll falhou:", (e as Error).message);
    }
    await sleep(POLL_MS);
  }
}

void loop();
