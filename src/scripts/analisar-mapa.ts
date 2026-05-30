/**
 * Analisa o `endpoints-mapeados.json` gerado por `npm run segfy:mapear` e
 * destila os contratos da API de automação/multicálculo (Segfy), mascarando
 * segredos (token/senha/CPF/etc.). Foco: achar os endpoints de DISPARO de
 * cotação e de POLLING de resultados, que só aparecem após submeter 1 cotação.
 *
 * Uso: npm run segfy:analisar            (lê o arquivo padrão)
 *      npm run segfy:analisar -- caminho/para/outro.json
 *
 * READ-ONLY: não faz rede, só lê o JSON local. Nunca imprime valores sensíveis.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ARQUIVO_PADRAO = resolve(__dirname, "../integrations/segfy/endpoints-mapeados.json");

// ---- mascaramento -----------------------------------------------------------
const SENSIVEL = /token|senha|password|authorization|secret|refresh|bearer|cpf|cnpj|nascimento|email/i;
function mascarar(v: unknown, chave = ""): unknown {
  if (SENSIVEL.test(chave)) return "[MASK]";
  if (typeof v === "string") return v.length > 60 ? `<str:${v.length}>` : v;
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => mascarar(x));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = mascarar(val, k);
    return o;
  }
  return v;
}
function parseMask(s?: string | null): unknown {
  if (!s) return undefined;
  try {
    return mascarar(JSON.parse(s));
  } catch {
    return s.length > 80 ? `<raw:${s.length}>` : s;
  }
}

// ---- modelo -----------------------------------------------------------------
interface Chamada {
  method: string;
  url: string;
  host?: string;
  status?: number;
  requestBody?: string;
  responseSample?: string;
}
interface WsFrame {
  ws: string;
  dir: "recv" | "sent";
  amostra: string;
}
interface Mapa {
  capturadoEm?: string;
  chamadas: Chamada[];
  wsFrames?: WsFrame[];
}

const RELEVANTE = /segfy\.com|run\.app/i;
const RUIDO = /hubspot|hubapi|hs-|doubleclick|google-?analytics|googletagmanager|nr-data|jam\.dev|youtube|gstatic|recaptcha|sentry|clarity/i;

// endpoints já confirmados no mapeamento de 29/05 (para separá-los do "novo").
const CONHECIDOS = [
  "/auth/login",
  "/auth/menus",
  "/auth/menusperfil",
  "/automation/api/profile/version/1.0/find-by-user",
  "/api/partners/version/1.0/list",
  "/api/vehicle/version/1.0/brand-list",
  "/api/vehicle/version/1.0/company-list",
  "/api/template/version/1.0/index",
  "/notifications/count",
  "/bgt/api/task/count",
  "/meus-pagamentos/badge",
  "/api/propostadashboard/dashboardpropostasinfo",
];
// pistas de que um endpoint é disparo de cotação ou polling de resultado.
const PISTA_DISPARO = /quot|budget|orcament|orçament|calcul|cotac|cotaç|proposal|proposta|insurance|emit|create|save|send/i;
const PISTA_POLLING = /result|status|poll|progress|situac|situaç|consult|retriev|get|find|list/i;

function pathDe(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    return url;
  }
}
function hostDe(c: Chamada): string {
  if (c.host) return c.host;
  try {
    return new URL(c.url).host;
  } catch {
    return "?";
  }
}

// ---- main -------------------------------------------------------------------
function main(): void {
  const arq = process.argv[2] ? resolve(process.argv[2]) : ARQUIVO_PADRAO;
  let mapa: Mapa;
  try {
    mapa = JSON.parse(readFileSync(arq, "utf8")) as Mapa;
  } catch (e) {
    console.error(`Não consegui ler ${arq}: ${e instanceof Error ? e.message : String(e)}`);
    console.error("Rode `npm run segfy:mapear`, faça 1 cotação e Ctrl+C para gerar o arquivo.");
    process.exit(1);
  }

  const calls = (mapa.chamadas ?? []).filter((c) => {
    const h = hostDe(c);
    return RELEVANTE.test(h) && !RUIDO.test(h);
  });

  // dedup por (method + host + path), contando ocorrências (polling = muitas).
  const porChave = new Map<string, { c: Chamada; n: number }>();
  for (const c of calls) {
    const chave = `${c.method} ${hostDe(c)}${pathDe(c.url)}`;
    const reg = porChave.get(chave);
    if (reg) {
      reg.n++;
      if (reg.c.responseSample === undefined && c.responseSample) reg.c = c; // prefere uma com corpo
    } else {
      porChave.set(chave, { c, n: 1 });
    }
  }

  console.log(`\n=== ${porChave.size} endpoints únicos (de ${calls.length} chamadas relevantes; capturado ${mapa.capturadoEm ?? "?"}) ===\n`);

  const novos: Array<{ chave: string; c: Chamada; n: number }> = [];
  for (const [chave, { c, n }] of porChave) {
    const path = pathDe(c.url).toLowerCase();
    const conhecido = CONHECIDOS.some((k) => path === k || path.startsWith(k));
    const marca = conhecido ? "  " : "🆕";
    const flags = [
      !conhecido && PISTA_DISPARO.test(path) ? "DISPARO?" : "",
      n >= 3 ? `POLLING? (${n}x)` : "",
    ].filter(Boolean).join(" ");
    console.log(`${marca} ${chave} [${c.status ?? "?"}]${flags ? "  ← " + flags : ""}`);
    if (!conhecido) novos.push({ chave, c, n });
  }

  if (novos.length === 0) {
    console.log("\n⚠️ Nenhum endpoint NOVO além dos já confirmados. A cotação foi disparada?");
    console.log("   Verifique se chegou a clicar em Cotar/Calcular e ver resultados das seguradoras.");
    return;
  }

  console.log(`\n=== ${novos.length} endpoints NOVOS — contratos (mascarados) ===\n`);
  for (const { chave, c, n } of novos) {
    console.log(`### ${chave}  ${n > 1 ? `(${n}x)` : ""}`);
    const req = parseMask(c.requestBody);
    if (req !== undefined) console.log(`  req: ${JSON.stringify(req)}`);
    const res = parseMask(c.responseSample);
    if (res !== undefined) console.log(`  res: ${JSON.stringify(res)}`);
    console.log("");
  }

  console.log("Dica: o DISPARO costuma ser um POST único com payload grande (segurado+veículo+coberturas);");
  console.log("o POLLING é a mesma URL chamada várias vezes retornando status/resultados por seguradora.");

  // WebSocket: é por aqui que chegam os RESULTADOS (preços por seguradora).
  const ws = mapa.wsFrames ?? [];
  if (ws.length > 0) {
    const urls = [...new Set(ws.map((f) => f.ws))].filter((u) => /segfy|run\.app/i.test(u));
    console.log(`\n=== WebSocket: ${ws.length} frames em ${urls.length} canal(is) ===`);
    for (const u of urls) console.log(`  ${u}`);
    // Mostra frames RECEBIDOS que parecem resultado (preço/seguradora/status).
    const interessantes = ws.filter(
      (f) => f.dir === "recv" && /premio|premium|preco|preço|parcela|company|insurer|result|valor|cotac/i.test(f.amostra),
    );
    console.log(`\n--- ${interessantes.length} frames RECEBIDOS com cara de resultado (mascarados) ---`);
    for (const f of interessantes.slice(0, 8)) {
      console.log(`  [${f.ws.slice(0, 40)}…] ${JSON.stringify(parseMask(f.amostra))}`);
    }
    if (interessantes.length === 0 && ws.length > 0) {
      console.log("  (nenhum frame com palavras-chave de preço — cole alguns frames recv manualmente p/ eu ver)");
    }
  } else {
    console.log("\n(⚠️ nenhum frame de WebSocket capturado — os preços chegaram? aguardou os resultados antes do Ctrl+C?)");
  }
}

main();
