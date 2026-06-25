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
import readline from "node:readline";
import os from "node:os";
import axios from "axios";
import { chromium, type Page } from "playwright";
import { capturarPagina } from "../integrations/descoberta/captura/cdp-har.capture";
import { criarPaginaPlaywright } from "../integrations/descoberta/runtime/playwright-page";
import { executarRpa, assarSeletores } from "../integrations/descoberta/runtime/rpa-runner";
import { gerarSpecInicial } from "../integrations/descoberta/construtor/spec-template";
import { validarEstrutura } from "../integrations/descoberta/validacao/estrutura.validator";
import { avaliarCriterio, criterioPadrao, type ResultadoObjetivo } from "../integrations/descoberta/criterio/avaliar";
import { resolverSeletor } from "../integrations/apolice/llm/portal-mapper.service";
import type { Objetivo, PassoRpa } from "../integrations/descoberta/descoberta.types";

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

/** sinaliza ao backend que o agente está VIVO (Admin mostra online/offline). */
async function heartbeat(): Promise<void> {
  await axios
    .post(`${BACKEND}/api/descoberta/agente/heartbeat`, { host: os.hostname() }, { headers: headers(), timeout: 15_000 })
    .catch(() => undefined);
}

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

// ── v2: jobs de CONSTRUÇÃO (objetivo-primeiro: login assistido + passos autônomos) ──

interface JobConstrucao {
  id: string;
  corretora_id: string;
  sistema: string;
  ramo: string | null;
  resumo: { seguradoraConfigId?: string; objetivo?: Objetivo; url?: string; casoTeste?: { dados?: Record<string, unknown>; propostaTeste?: string } } | null;
}

function aguardarEnter(msg: string): Promise<void> {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, () => {
      rl.close();
      res();
    });
  });
}

async function pegarConstrucao(): Promise<JobConstrucao | null> {
  const r = await axios.get(`${BACKEND}/api/descoberta/agente/construcao/trabalho`, { headers: headers(), timeout: 90_000 });
  return (r.data?.job as JobConstrucao | null) ?? null;
}

async function reportarConstrucao(payload: Record<string, unknown>): Promise<void> {
  await axios
    .post(`${BACKEND}/api/descoberta/agente/construcao/reportar`, payload, { headers: headers(), timeout: 120_000 })
    .catch((e) => console.log("reportar construção falhou:", (e as Error).message));
}

/** marcador de evolução em tempo real (grid de monitoramento no Admin). */
async function progresso(jobId: string, etapa: string): Promise<void> {
  await axios
    .post(`${BACKEND}/api/descoberta/agente/construcao/progresso`, { jobId, etapa }, { headers: headers(), timeout: 30_000 })
    .catch(() => undefined);
}

/** o operador cancelou o job? (checado em pontos-chave, inclusive antes de emitir). */
async function cancelado(jobId: string): Promise<boolean> {
  try {
    const r = await axios.get(`${BACKEND}/api/descoberta/agente/construcao/${jobId}/status`, { headers: headers(), timeout: 30_000 });
    return r.data?.status === "cancelado";
  } catch {
    return false;
  }
}

/** Passos AUTÔNOMOS = remove os passos de LOGIN (o operador faz login no modo híbrido). */
function passosAutonomos(passos: PassoRpa[]): PassoRpa[] {
  return passos.filter((p) => {
    if (p.tipo === "navegar") return false;
    if (p.tipo === "preencher" && p.papel && /login_/.test(p.seletor)) return false;
    if (p.tipo === "clicar" && p.papel && /login_/.test(p.seletor)) return false;
    if (p.tipo === "esperar" && (p as { sairDeUrl?: string }).sairDeUrl === "/login") return false;
    return true;
  });
}

async function processarConstrucao(job: JobConstrucao): Promise<void> {
  const objetivo = (job.resumo?.objetivo ?? "apolice") as Objetivo;
  const url = job.resumo?.url;
  const seguradoraConfigId = job.resumo?.seguradoraConfigId;
  if (!url || !seguradoraConfigId) {
    await reportarConstrucao({ jobId: job.id, corretoraId: job.corretora_id, seguradoraConfigId: seguradoraConfigId ?? "", sistema: job.sistema, ramo: job.ramo ?? "auto", objetivo, status: "erro", erro: "job_incompleto" });
    return;
  }
  const specInicial = gerarSpecInicial({ sistema: job.sistema, seguradoraConfigId, ramo: job.ramo ?? "auto", objetivo, urlPortal: url });
  const built = await criarPaginaPlaywright(false); // VISÍVEL (operador no laço)
  try {
    console.log(`\n[construção] Abrindo ${url} (objetivo: ${objetivo})`);
    await progresso(job.id, "abrindo_portal");
    await built.page.navegar(url);

    // PORTÃO: validação de estrutura (markup pós-navegação)
    await progresso(job.id, "validando_estrutura");
    const markup = (await built.pageNativa.content().catch(() => "")).slice(0, 200_000);
    const vEstr = validarEstrutura(objetivo, { markup, loginOk: false });
    if (vEstr.veredito === "nao_suporta") {
      console.log(`[construção] estrutura NÃO suporta: faltou ${vEstr.lacunas.join(", ")}`);
      await reportarConstrucao({ jobId: job.id, corretoraId: job.corretora_id, seguradoraConfigId, sistema: job.sistema, ramo: job.ramo ?? "auto", objetivo, status: "nao_suporta", erro: `lacunas: ${vEstr.lacunas.join(", ")}` });
      return;
    }
    if (objetivo === "validar_estrutura") {
      await reportarConstrucao({ jobId: job.id, corretoraId: job.corretora_id, seguradoraConfigId, sistema: job.sistema, ramo: job.ramo ?? "auto", objetivo, status: "validado", spec: specInicial, url });
      return;
    }

    // checagem de cancelamento ANTES de pedir o login
    if (await cancelado(job.id)) {
      console.log("[construção] cancelado pelo operador — encerrando.");
      return;
    }

    // LOGIN ASSISTIDO (híbrido): operador resolve login/2FA/captcha
    await progresso(job.id, "aguardando_login_operador");
    await aguardarEnter("[construção] >>> Faça LOGIN (e 2FA/captcha) no navegador. Quando estiver logado, pressione ENTER aqui… ");

    // checagem de cancelamento ANTES dos passos autônomos (inclui o emitir irreversível)
    if (await cancelado(job.id)) {
      console.log("[construção] cancelado pelo operador antes de executar — encerrando (nada emitido).");
      return;
    }

    // PASSOS AUTÔNOMOS (sem login): o agente busca → emite → extrai
    await progresso(job.id, "executando_passos");
    const autonomos = passosAutonomos(specInicial.passosRpa ?? []);
    const contexto: Record<string, unknown> = { proposta: job.resumo?.casoTeste?.propostaTeste ?? "", ...(job.resumo?.casoTeste?.dados ?? {}) };
    if (objetivo === "apolice") {
      console.log("[construção] >>> ATENÇÃO: este objetivo EMITE 1 apólice real de validação.");
    }
    const r = await executarRpa(autonomos, contexto, built.page, {
      resolverSeletor: async (papel) =>
        resolverSeletor({ seguradora: job.sistema, acao: papel, descricaoAcao: `Elemento para "${papel}" (${objetivo}).`, corretoraId: job.corretora_id, page: built.pageNativa }),
      log: (m) => console.log("  ·", m),
    });
    await progresso(job.id, "avaliando_criterio");
    const pdf = built.page.ultimoPdf ? await built.page.ultimoPdf() : null;
    const resultado: ResultadoObjetivo = { numeroApolice: r.numeroApolice, pdfBytes: pdf?.length ?? 0, campos: r.campos };
    const avaliacao = avaliarCriterio(criterioPadrao(objetivo), resultado);
    console.log(`[construção] critério: ${avaliacao.atingido ? "ATINGIDO" : "não atingido"} — ${avaliacao.motivo}`);

    // "assa" os seletores resolvidos no spec → código de scraping DETERMINÍSTICO
    const specFinal = { ...specInicial, passosRpa: assarSeletores(specInicial.passosRpa ?? [], r.seletoresResolvidos) };
    const base = { jobId: job.id, corretoraId: job.corretora_id, seguradoraConfigId, sistema: job.sistema, ramo: job.ramo ?? "auto", objetivo, casoTeste: job.resumo?.casoTeste, url };

    if (avaliacao.atingido) {
      await reportarConstrucao({ ...base, status: "validado", spec: specFinal, criterioSucesso: criterioPadrao(objetivo) });
      console.log("[construção] VALIDADO — adapter (código de scraping) gravado no Admin › Integrações.");
    } else {
      // apólice NÃO re-tenta o emitir (irreversível) → escala p/ humano; salva RASCUNHO
      await reportarConstrucao({ ...base, status: "requer_humano", spec: specFinal, erro: avaliacao.motivo });
      console.log("[construção] Não atingiu o objetivo — código parcial salvo como rascunho p/ revisão.");
    }
  } catch (e) {
    await reportarConstrucao({ jobId: job.id, corretoraId: job.corretora_id, seguradoraConfigId, sistema: job.sistema, ramo: job.ramo ?? "auto", objetivo, status: "erro", erro: (e as Error).message });
  } finally {
    await built.fechar();
  }
}

async function loop(): Promise<void> {
  if (!BACKEND || !TOKEN) {
    console.error("[descoberta-agent] defina DESCOBERTA_AGENT_BACKEND_URL e DESCOBERTA_AGENT_TOKEN no .env");
    process.exit(1);
  }
  console.log("[descoberta-agent] no ar; aguardando jobs de descoberta/construção…");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await heartbeat(); // sinaliza vivo a cada ciclo (Admin mostra "agente online")
      const construcao = await pegarConstrucao();
      if (construcao) {
        console.log(`[descoberta-agent] CONSTRUÇÃO ${construcao.id} (${construcao.sistema})`);
        await processarConstrucao(construcao);
      }
      const job = await pegarTrabalho();
      if (job) {
        console.log(`[descoberta-agent] descoberta ${job.id} (${job.sistema}/${job.ramo ?? "?"})`);
        await processar(job);
      }
    } catch (e) {
      console.log("[descoberta-agent] poll falhou:", (e as Error).message);
    }
    await sleep(POLL_MS);
  }
}

void loop();
