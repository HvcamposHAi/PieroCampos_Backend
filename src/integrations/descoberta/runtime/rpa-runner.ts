/**
 * RPA-RUNNER — executa os passos DOM (`PassoRpa[]`) de um AdapterSpec contra uma
 * página. WHITELIST de passos, SEM `eval`. A `PaginaRpa` é injetada (no daemon é
 * um wrapper de Playwright; nos testes é um fake) — o runner é PURO em relação a
 * Playwright, então é unit-testável. Usado p/ emissão de apólice / formulários.
 *
 * `seletor` pode ser estático OU um "papel" resolvido por LLM em runtime (reusa
 * o portal-selector via `deps.resolverSeletor`). Nunca loga PII/valores.
 */
import type {
  PassoClicar,
  PassoEsperar,
  PassoExtrairCampo,
  PassoNavegar,
  PassoPreencher,
  PassoRpa,
} from "../descoberta.types";
import { aplicarTemplate } from "../descoberta.util";

/** Página abstrata (Playwright no daemon; fake no teste). */
export interface PaginaRpa {
  navegar(url: string): Promise<void>;
  preencher(seletor: string, valor: string): Promise<void>;
  /** retorna o tamanho do download (bytes) quando `esperarDownload`. */
  clicar(seletor: string, opts?: { esperarDownload?: boolean }): Promise<{ downloadBytes?: number } | void>;
  esperarMs(ms: number): Promise<void>;
  esperarSeletor(seletor: string, timeoutMs?: number): Promise<void>;
  esperarSairDeUrl(padrao: string, timeoutMs?: number): Promise<void>;
  /** extrai texto por seletor CSS OU por regex de rótulo "/.../i". */
  extrair(seletorOuRegex: string): Promise<string | null>;
  /** bytes reais do último PDF baixado (emissão); o runner do BUILD usa só o tamanho. */
  ultimoPdf?(): Promise<Buffer | null>;
}

export interface RpaRunnerDeps {
  /** resolve um "papel" (ex.: 'botao_emitir') → seletor real (LLM). Opcional. */
  resolverSeletor?: (papel: string) => Promise<string | null>;
  log?: (msg: string) => void;
}

export interface RpaResultado {
  ok: boolean;
  campos: Record<string, string | number>;
  numeroApolice?: string | null;
  pdfBytes?: number;
  erro?: string;
  passoFalho?: string;
  /** papel → seletor CSS resolvido em runtime (p/ "assar" o spec determinístico). */
  seletoresResolvidos: Record<string, string>;
}

/** "R$ 1.234,56" → 1234.56 ; retorna NaN se não parsear. */
export function moedaBR(txt: string): number {
  const limpo = txt.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(limpo);
  return Number.isFinite(n) ? n : NaN;
}

function ehRegex(s: string): boolean {
  return /^\/.*\/[a-z]*$/i.test(s);
}

const TIPOS = new Set(["navegar", "preencher", "clicar", "esperar", "extrair_campo", "extrair_pdf"]);

/** Valida a whitelist de passos RPA (defesa: nada fora do conjunto conhecido). */
export function validarPassosRpa(passos: PassoRpa[]): { ok: boolean; erro?: string } {
  if (!Array.isArray(passos) || passos.length === 0) return { ok: false, erro: "sem_passos" };
  for (const p of passos) {
    if (!TIPOS.has((p as { tipo: string }).tipo)) return { ok: false, erro: `passo_invalido:${(p as { tipo: string }).tipo}` };
  }
  return { ok: true };
}

async function resolver(p: { seletor: string; papel?: boolean }, deps: RpaRunnerDeps): Promise<string | null> {
  if (p.papel && deps.resolverSeletor) return (await deps.resolverSeletor(p.seletor)) ?? null;
  return p.seletor;
}

/**
 * Executa os passos contra a página. Retorna campos extraídos + (se houver) o
 * numeroApolice e o tamanho do PDF. Para no primeiro passo que falhar.
 */
export async function executarRpa(
  passos: PassoRpa[],
  contexto: Record<string, unknown>,
  page: PaginaRpa,
  deps: RpaRunnerDeps = {},
): Promise<RpaResultado> {
  const val = validarPassosRpa(passos);
  if (!val.ok) return { ok: false, campos: {}, erro: val.erro, seletoresResolvidos: {} };

  const campos: Record<string, string | number> = {};
  const seletoresResolvidos: Record<string, string> = {};
  let pdfBytes: number | undefined;
  const log = deps.log ?? ((): void => undefined);

  // resolve um papel e REGISTRA o seletor (p/ "assar" o spec determinístico).
  const resolverReg = async (p: { seletor: string; papel?: boolean }): Promise<string | null> => {
    const sel = await resolver(p, deps);
    if (sel && p.papel) seletoresResolvidos[p.seletor] = sel;
    return sel;
  };

  try {
    for (const passo of passos) {
      switch (passo.tipo) {
        case "navegar": {
          await page.navegar(aplicarTemplate((passo as PassoNavegar).url, contexto));
          break;
        }
        case "preencher": {
          const p = passo as PassoPreencher;
          const sel = await resolverReg(p);
          if (!sel) return { ok: false, campos, erro: "seletor_nao_resolvido", passoFalho: `preencher:${p.descricao ?? p.seletor}`, seletoresResolvidos };
          await page.preencher(sel, aplicarTemplate(p.valor, contexto));
          break;
        }
        case "clicar": {
          const p = passo as PassoClicar;
          const sel = await resolverReg(p);
          if (!sel) return { ok: false, campos, erro: "seletor_nao_resolvido", passoFalho: `clicar:${p.descricao ?? p.seletor}`, seletoresResolvidos };
          const res = await page.clicar(sel, { esperarDownload: p.esperarDownload });
          if (p.esperarDownload && res && typeof res === "object" && typeof res.downloadBytes === "number") {
            pdfBytes = res.downloadBytes;
          }
          break;
        }
        case "esperar": {
          const p = passo as PassoEsperar;
          if (p.sairDeUrl) await page.esperarSairDeUrl(p.sairDeUrl, p.timeoutMs);
          else if (p.seletor) await page.esperarSeletor(p.seletor, p.timeoutMs);
          else await page.esperarMs(p.ms ?? 1000);
          break;
        }
        case "extrair_campo": {
          const p = passo as PassoExtrairCampo;
          const txt = await page.extrair(p.seletorOuRegex);
          if (txt != null) campos[p.nome] = p.comoMoeda ? moedaBR(txt) : txt.trim();
          log(`extraído ${p.nome}`);
          break;
        }
        case "extrair_pdf": {
          // o PDF veio do download do clique anterior (esperarDownload)
          break;
        }
      }
    }
  } catch (e) {
    return { ok: false, campos, pdfBytes, erro: e instanceof Error ? e.message : "erro_rpa", seletoresResolvidos };
  }

  const numeroApolice = typeof campos.numeroApolice === "string" ? campos.numeroApolice : null;
  return { ok: true, campos, numeroApolice, pdfBytes, seletoresResolvidos };
}

/**
 * "Assa" os seletores resolvidos no spec: troca os passos `papel` pelos seletores
 * CSS reais (papel:false). Resultado = código de scraping DETERMINÍSTICO p/ salvar
 * no banco. Passos não resolvidos permanecem como papel (ainda dependem de LLM).
 */
export function assarSeletores(passos: PassoRpa[], resolvidos: Record<string, string>): PassoRpa[] {
  return passos.map((p) => {
    if ((p.tipo === "preencher" || p.tipo === "clicar") && p.papel && resolvidos[p.seletor]) {
      return { ...p, seletor: resolvidos[p.seletor]!, papel: false };
    }
    return p;
  });
}
