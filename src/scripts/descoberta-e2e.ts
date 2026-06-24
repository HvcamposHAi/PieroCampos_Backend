/**
 * E2E (offline) do ADI sobre as SEGURADORAS reais cadastradas na plataforma.
 *
 * NÃO faz captura live (isso exige o operador no navegador: login/2FA/captcha).
 * Em vez disso: (1) lê `seguradoras_config` real (read-only), (2) roda o PIPELINE
 * REAL do ADI (inferência→contrato/API-Doc→adapter) sobre um HAR REPRESENTATIVO
 * do grupo de integração de cada seguradora, e (3) emite uma dashboard HTML
 * self-contained + um JSON com o resultado do mapeamento. Também cruza com os
 * contratos JÁ descobertos de verdade (pagina_contrato), se houver.
 *
 * Rode: npx tsx src/scripts/descoberta-e2e.ts   → escreve em c:/tmp/adi-status.html
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { getSupabaseAdmin } from "../integrations/whatsapp/supabase";
import { montarContrato } from "../integrations/descoberta/contrato-builder";
import { inferirContrato } from "../integrations/descoberta/inferencia/har-para-contrato";
import { gerarAdapter } from "../integrations/descoberta/gerador/adapter-gen";
import type { AnaliseSeguranca, HarResumo, PaginaContrato } from "../integrations/descoberta/descoberta.types";

const SAIDA = process.env.ADI_E2E_OUT ?? "c:/tmp/adi-status.html";

interface SeguradoraRow {
  id: string;
  nome_display: string;
  ativo: boolean;
  grupo_integracao: "A_api" | "B_rpa" | "C_otp";
  ramos: string[] | null;
  status_acesso: string | null;
  url_portal: string | null;
  corretora_id?: string | null;
}

function slug(nome: string): string {
  return nome.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "").slice(0, 24) || "portal";
}

/** HAR REPRESENTATIVO por grupo de integração (simulação do que a captura veria). */
function harRepresentativo(s: SeguradoraRow): { har: HarResumo; markup: string } {
  const host = `https://api.${slug(s.nome_display)}.com.br`;
  const ramos = s.ramos && s.ramos.length ? s.ramos : ["auto"];
  const domLinks = ramos.map((r) => ({ texto: r, href: `/produtos/${r}` }));

  if (s.grupo_integracao === "A_api") {
    // Portal com API HTTP/JSON limpa (estilo Aggilizador): token→criar→calcular→poll
    return {
      markup: '<html><body><form><input name="email"><input type="password" name="senha"></form></body></html>',
      har: {
        domLinks,
        entradas: [
          { metodo: "POST", url: `${host}/usuario/login`, status: 200, reqHeaders: { "content-type": "application/json" }, reqBody: { email: "[REDACTED]", senha: "[REDACTED]" }, respBody: { data: { token: "[REDACTED]" }, success: true } },
          { metodo: "POST", url: `${host}/cadastros/cliente`, status: 200, reqHeaders: { authorization: "[REDACTED]" }, reqBody: { cpf: "123.456.789-00", nome: "[REDACTED]", cep: "01001-000", dataNascimento: "1990-01-01" }, respBody: { id: "seg_1" } },
          { metodo: "POST", url: `${host}/calculo/calcularV2`, status: 200, reqHeaders: { authorization: "[REDACTED]" }, reqBody: { placa: "ABC1D23", idIntegracao: 0 }, respBody: { id: "calc_9", versao: 1 } },
          { metodo: "GET", url: `${host}/calculo/cotacao/calculos/calc_9/1`, status: 200, reqHeaders: { authorization: "[REDACTED]" }, respBody: { resultados: [{ seguradora: s.nome_display, premio: 2480.5, parcelas: 10, valorParcela: 248.05, retorno: true, status: "cotado" }] } },
        ],
      },
    };
  }

  if (s.grupo_integracao === "C_otp") {
    // Portal com login + OTP (2FA) e captcha — RPA assistido
    return {
      markup:
        '<html><body><form><input name="usuario"><input type="password" name="senha">' +
        '<div class="g-recaptcha"></div><label>Código de verificação (OTP)</label><input name="otp"></form>' +
        '<script src="https://www.google.com/recaptcha/api.js"></script></body></html>',
      har: {
        domLinks,
        entradas: [
          { metodo: "GET", url: `https://portal.${slug(s.nome_display)}.com.br/login`, status: 200, reqHeaders: {} },
          { metodo: "POST", url: `https://portal.${slug(s.nome_display)}.com.br/auth`, status: 200, reqHeaders: { "content-type": "application/json" }, reqBody: { usuario: "[REDACTED]", senha: "[REDACTED]" }, respBody: { ok: true, mfa: true } },
          { metodo: "POST", url: `https://portal.${slug(s.nome_display)}.com.br/cotacao`, status: 200, reqHeaders: { cookie: "[REDACTED]" }, reqBody: { cpf: "123.456.789-00", placa: "ABC1D23", cep: "01001-000" }, respBody: { resultados: [{ seguradora: s.nome_display, premio: 3120.0, status: "cotado" }] } },
        ],
      },
    };
  }

  // B_rpa: portal de formulário com login por cookie (sem OTP), possível captcha
  return {
    markup:
      '<html><body><form><input name="login"><input type="password" name="senha"></form>' +
      '<a href="/produtos/auto">Auto</a><a href="/produtos/residencial">Residência</a></body></html>',
    har: {
      domLinks,
      entradas: [
        { metodo: "GET", url: `https://portal.${slug(s.nome_display)}.com.br/login`, status: 200, reqHeaders: {} },
        { metodo: "POST", url: `https://portal.${slug(s.nome_display)}.com.br/sessao`, status: 200, reqHeaders: { "content-type": "application/json" }, reqBody: { login: "[REDACTED]", senha: "[REDACTED]" }, respBody: { ok: true } },
        { metodo: "POST", url: `https://portal.${slug(s.nome_display)}.com.br/calcular`, status: 200, reqHeaders: { cookie: "[REDACTED]" }, reqBody: { cpf: "123.456.789-00", placa: "ABC1D23" }, respBody: { resultados: [{ seguradora: s.nome_display, premio: 2890.0, status: "cotado" }] } },
      ],
    },
  };
}

interface ResultadoSeg {
  seg: SeguradoraRow;
  contrato: PaginaContrato;
  endpoints: number;
  passos: number;
  jaDescoberto: boolean;
}

function esc(s: unknown): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function badge(txt: string, cor: string): string {
  return `<span class="badge" style="background:${cor}1a;color:${cor};border:1px solid ${cor}55">${esc(txt)}</span>`;
}

function dot(ok: boolean): string {
  return ok ? '<span class="dot ok"></span>' : '<span class="dot off"></span>';
}

function gerarHtml(resultados: ResultadoSeg[], geradoEm: string): string {
  const linhas = resultados
    .map((r, i) => {
      const seg = r.contrato.seguranca as AnaliseSeguranca;
      const cobre = r.contrato.ramosDisponiveis.map((x) => x.ramo).join(", ") || "—";
      const grupoCor = r.seg.grupo_integracao === "A_api" ? "#0ea5e9" : r.seg.grupo_integracao === "C_otp" ? "#a855f7" : "#f59e0b";
      const estagio = r.jaDescoberto ? badge("descoberto (real)", "#10b981") : badge("simulado", "#64748b");
      const premissasChips = r.contrato.premissas
        .map((p) => `<span class="chip">${esc(p.chave)}<i>${esc(p.valor)}</i></span>`)
        .join("");
      return `
      <tr onclick="document.getElementById('d${i}').classList.toggle('open')">
        <td><b>${esc(r.seg.nome_display)}</b><div class="muted">${esc(r.seg.url_portal ?? "")}</div></td>
        <td>${badge(r.seg.grupo_integracao, grupoCor)}</td>
        <td>${r.seg.ativo ? badge("ativa", "#10b981") : badge("inativa", "#64748b")}</td>
        <td>${esc(cobre)}</td>
        <td style="text-align:center">${dot(true)} ${r.endpoints}</td>
        <td style="text-align:center">${seg.twoFactor?.presente ? badge("2FA", "#a855f7") : "—"} ${seg.captcha?.presente ? badge(seg.captcha.tipo ?? "captcha", "#ef4444") : ""} ${seg.transporte?.tlsTudo ? badge("TLS", "#10b981") : badge("HTTP!", "#ef4444")}</td>
        <td style="text-align:center">${r.passos}</td>
        <td>${estagio}</td>
      </tr>
      <tr class="detalhe" id="d${i}"><td colspan="8">
        <div class="grid">
          <div><h4>Premissas (${r.contrato.premissas.length})</h4>${premissasChips}</div>
          <div><h4>Segurança</h4>
            <div class="muted">auth: ${esc(seg.auth?.esquema)} · 2FA: ${seg.twoFactor?.presente ? "sim" : "não"} · captcha: ${seg.captcha?.presente ? esc(seg.captcha.tipo) : "não"} · TLS: ${seg.transporte?.tlsTudo ? "sim" : "NÃO"} · PII: ${esc((seg.piiTrafegada ?? []).join(", ") || "—")}</div>
          </div>
          <div><h4>Seguros detectados</h4>${r.contrato.ramosDisponiveis.map((x) => `<span class="chip">${esc(x.rotuloNoPortal || x.ramo)}<i>${esc(x.statusSuporte)}</i></span>`).join("") || "—"}</div>
          <div><h4>Fluxo (${r.contrato.fluxo.length} etapas)</h4><div class="muted">${r.contrato.fluxo.map((f) => esc(f.nome)).join(" → ") || "—"}</div></div>
        </div>
      </td></tr>`;
    })
    .join("");

  const totalSeg = resultados.length;
  const comApi = resultados.filter((r) => r.seg.grupo_integracao === "A_api").length;
  const com2fa = resultados.filter((r) => (r.contrato.seguranca as AnaliseSeguranca).twoFactor?.presente).length;
  const comCaptcha = resultados.filter((r) => (r.contrato.seguranca as AnaliseSeguranca).captcha?.presente).length;
  const descobertosReais = resultados.filter((r) => r.jaDescoberto).length;

  const checklist = [
    ["Núcleo (inferência→contrato→adapter→runner)", true, "commit 2e305cf"],
    ["Persistência + rotas (admin/agente) + app.ts", true, "commit cfc20ad"],
    ["Captura CDP/HAR + daemon descoberta:agent", true, "commit cfc20ad"],
    ["Frontend (aba Integrações + API-Doc viewer)", true, "commit df45e17"],
    ["DDL aplicado (cláusulas A–E + bucket)", true, "em prod"],
    ["Flags ligadas (DESCOBERTA_ENABLED + token)", true, "Render + daemon"],
    ["E2E LIVE por portal (captura real)", false, "pendente: operador no navegador"],
    ["Execução em prod (DESCOBERTA_EXEC_ENABLED + toggle)", false, "ligar por corretora quando validar"],
  ]
    .map(([t, ok, nota]) => `<li>${dot(ok as boolean)} <b>${esc(t)}</b> <span class="muted">— ${esc(nota)}</span></li>`)
    .join("");

  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ADI — Status do desenvolvimento</title>
<style>
:root{--bg:#0b1020;--card:#121a30;--bd:#243049;--tx:#e6edf6;--mut:#8aa0bd;--brand:#38bdf8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em;margin:28px 0 12px}
.sub{color:var(--mut);margin:0 0 18px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:8px}
.kpi{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px}
.kpi b{font-size:26px;display:block}.kpi span{color:var(--mut);font-size:12px}
.panel{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:8px 4px;overflow:hidden}
table{width:100%;border-collapse:collapse}th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--bd);vertical-align:top}
th{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
tr:not(.detalhe){cursor:pointer}tr:not(.detalhe):hover{background:#1a2540}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;margin-right:4px;white-space:nowrap}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%}.dot.ok{background:#10b981}.dot.off{background:#f59e0b}
.muted{color:var(--mut);font-size:12px}
.detalhe{display:none;background:#0e1730}.detalhe.open{display:table-row}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;padding:8px 8px 14px}
.grid h4{margin:0 0 6px;font-size:12px;color:var(--brand);text-transform:uppercase;letter-spacing:.04em}
.chip{display:inline-block;background:#1a2540;border:1px solid var(--bd);border-radius:8px;padding:2px 8px;margin:0 6px 6px 0;font-size:12px}
.chip i{color:var(--mut);font-style:normal;margin-left:6px}
ul.check{list-style:none;padding:0;margin:0;background:var(--card);border:1px solid var(--bd);border-radius:12px}
ul.check li{padding:10px 14px;border-bottom:1px solid var(--bd)}ul.check li:last-child{border:0}
.flag{background:#3a1d1d;border:1px solid #7f1d1d;color:#fecaca;border-radius:10px;padding:10px 14px;font-size:13px;margin:14px 0}
</style></head><body><div class="wrap">
<h1>🛰️ ADI — Agente Descobridor &amp; Forja de Integrações</h1>
<p class="sub">Status do desenvolvimento + mapeamento das seguradoras cadastradas · gerado em ${esc(geradoEm)}</p>

<div class="flag">⚠️ <b>Simulação controlada:</b> a captura <u>live</u> de cada portal exige o operador no navegador (login + 2FA/captcha) e não foi executada aqui. As linhas abaixo rodam o <b>pipeline REAL do ADI</b> sobre um <b>HAR representativo</b> do grupo de integração de cada seguradora — servem para validar a montagem da API-Doc, premissas e adapter. Onde houver <b>“descoberto (real)”</b>, veio de uma captura de verdade já no banco.</div>

<div class="cards">
  <div class="kpi"><b>${totalSeg}</b><span>seguradoras cadastradas</span></div>
  <div class="kpi"><b>${comApi}</b><span>com API limpa (A_api)</span></div>
  <div class="kpi"><b>${com2fa}</b><span>exigem 2FA</span></div>
  <div class="kpi"><b>${comCaptcha}</b><span>com captcha detectado</span></div>
  <div class="kpi"><b>${descobertosReais}</b><span>descobertas reais</span></div>
</div>

<h2>Mapeamento por seguradora <span class="muted">(clique numa linha p/ ver a API-Doc)</span></h2>
<div class="panel"><table>
<thead><tr><th>Seguradora</th><th>Grupo</th><th>Cadastro</th><th>Seguros</th><th>Endpoints</th><th>Segurança</th><th>Passos adapter</th><th>Estágio</th></tr></thead>
<tbody>${linhas || '<tr><td colspan="8" class="muted">Nenhuma seguradora cadastrada.</td></tr>'}</tbody>
</table></div>

<h2>Status do desenvolvimento</h2>
<ul class="check">${checklist}</ul>
</div></body></html>`;
}

async function main(): Promise<void> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("seguradoras_config")
    .select("id, nome_display, ativo, grupo_integracao, ramos, status_acesso, url_portal, corretora_id")
    .order("nome_display", { ascending: true });
  if (error) throw error;
  const seguradoras = (data as unknown as SeguradoraRow[]) ?? [];

  // contratos já descobertos de verdade (para marcar "real" no board)
  const { data: contratosReais } = await sb.from("pagina_contrato").select("sistema");
  const sistemasReais = new Set((contratosReais as { sistema: string }[] | null)?.map((c) => c.sistema) ?? []);

  const corretoraId = seguradoras.find((s) => s.corretora_id)?.corretora_id ?? "00000000-0000-0000-0000-000000000001";

  const resultados: ResultadoSeg[] = seguradoras.map((seg) => {
    const ramoPrincipal = (seg.ramos && seg.ramos[0]) || "auto";
    const { har, markup } = harRepresentativo(seg);
    const contrato = montarContrato({
      corretoraId: corretoraId!,
      sistema: slug(seg.nome_display),
      ramo: ramoPrincipal,
      har,
      dom: { markup },
      ramosSuportados: ["auto"],
    });
    const endpoints = inferirContrato(har).endpoints.length;
    const spec = gerarAdapter({ contrato: inferirContrato(har), sistema: slug(seg.nome_display), ramo: ramoPrincipal });
    return { seg, contrato, endpoints, passos: spec.passos.length, jaDescoberto: sistemasReais.has(slug(seg.nome_display)) };
  });

  const geradoEm = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  writeFileSync(SAIDA, gerarHtml(resultados, geradoEm), "utf8");

  // resumo no console
  console.log(`\n=== ADI E2E — ${seguradoras.length} seguradoras ===`);
  for (const r of resultados) {
    const seg = r.contrato.seguranca as AnaliseSeguranca;
    console.log(
      `• ${r.seg.nome_display.padEnd(22)} [${r.seg.grupo_integracao}] endpoints=${r.endpoints} passos=${r.passos} ` +
        `2FA=${seg.twoFactor?.presente ? "S" : "N"} captcha=${seg.captcha?.presente ? seg.captcha.tipo : "N"} ` +
        `premissas=${r.contrato.premissas.length} seguros=[${r.contrato.ramosDisponiveis.map((x) => x.ramo).join(",")}]`,
    );
  }
  console.log(`\nDashboard: ${SAIDA}`);
}

void main().catch((e) => {
  console.error("E2E falhou:", e instanceof Error ? e.message : e);
  process.exit(1);
});
