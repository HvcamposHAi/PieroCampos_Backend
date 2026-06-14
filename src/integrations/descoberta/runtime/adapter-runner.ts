/**
 * RUNNER determinístico do `AdapterSpec`. Interpreta uma whitelist de passos
 * (auth|http|poll|extract) — SEM eval, sem código gerado executável. Implementa
 * a porta `QuoteProvider`, então pluga no registry como qualquer outro sistema.
 *
 * Resiliência: retry backoff+jitter (resiliencia.ts), circuit breaker por
 * (corretora,sistema), timeout de poll, idempotência (chave hash dos dados).
 * FAIL-CLOSED: qualquer erro irrecuperável → retorna null (o caller escala).
 */
import type { QuoteContext, QuoteProvider, QuoteResult } from "../../quote/quote-provider.port";
import type { PersistencePort } from "../../segfy/persistence.port";
import type { ResultadoCotacaoItem } from "../../segfy/segfy.types";
import type { AdapterSpec, PassoAuth, PassoExtract, PassoHttp, PassoPoll } from "../descoberta.types";
import { aplicarTemplate, aplicarTemplateObj, lerCaminho } from "../descoberta.util";
import { CircuitBreaker, comRetry, ErroHttp } from "./resiliencia";

/** Requisição/resposta HTTP genérica (injetável p/ teste). */
export interface HttpReq {
  metodo: string;
  url: string;
  headers?: Record<string, string>;
  corpo?: unknown;
}
export interface HttpResp {
  status: number;
  corpo: unknown;
}
export type HttpFn = (req: HttpReq) => Promise<HttpResp>;

export interface RunnerDeps {
  http: HttpFn;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  circuit?: CircuitBreaker;
}

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Hash estável (FNV-1a) de um objeto p/ idempotência — sem PII no resultado. */
export function hashDados(dados: Record<string, unknown>): string {
  const json = JSON.stringify(dados, Object.keys(dados).sort());
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

async function chamarHttp(deps: RunnerDeps, req: HttpReq, spec: AdapterSpec): Promise<HttpResp> {
  const resp = await comRetry(
    async () => {
      const r = await deps.http(req);
      if (r.status >= 400) throw new ErroHttp(r.status);
      return r;
    },
    {
      maxRetries: spec.resiliencia?.maxRetries ?? 3,
      baseMs: spec.resiliencia?.backoffBaseMs ?? 500,
      sleep: deps.sleep ?? sleepReal,
      rand: deps.rand,
    },
  );
  return resp;
}

function itensDe(resp: unknown, arrayEm: string): unknown[] {
  const base = arrayEm ? lerCaminho(resp, arrayEm) : resp;
  if (Array.isArray(base)) return base;
  if (Array.isArray(resp)) return resp;
  return base == null ? [] : [base];
}

function estaPronto(resp: unknown, pq: PassoPoll["prontoQuando"], arrayEm: string): boolean {
  const itens = itensDe(resp, arrayEm);
  if (itens.length === 0) return false;
  const ok = (it: unknown): boolean => {
    const v = lerCaminho(it, pq.caminho);
    if (pq.igualA !== undefined) return v === pq.igualA;
    if (pq.existe) return v != null;
    return Boolean(v);
  };
  return itens.every(ok);
}

function extrair(resp: unknown, passo: PassoExtract): ResultadoCotacaoItem[] {
  const itens = itensDe(resp, passo.arrayEm);
  const out: ResultadoCotacaoItem[] = [];
  for (const it of itens) {
    const num = (cam?: string): number => {
      const v = cam ? lerCaminho(it, cam) : undefined;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const str = (cam?: string): string => {
      const v = cam ? lerCaminho(it, cam) : undefined;
      return v == null ? "" : String(v);
    };
    const premio = num(passo.mapa.premio_total);
    out.push({
      seguradora: str(passo.mapa.seguradora) || "—",
      premio_total: premio,
      parcelas: passo.mapa.parcelas ? Math.max(1, Math.round(num(passo.mapa.parcelas))) : 1,
      valor_parcela: passo.mapa.valor_parcela ? num(passo.mapa.valor_parcela) : 0,
      coberturas_resumo: passo.mapa.coberturas_resumo ? str(passo.mapa.coberturas_resumo) : "",
      status: passo.mapa.status ? str(passo.mapa.status) || "cotado" : premio > 0 ? "cotado" : "recusado",
    });
  }
  return out;
}

/** Valida a forma da spec (whitelist de tipos de passo). */
export function validarSpec(spec: AdapterSpec): { ok: boolean; erro?: string } {
  if (!Array.isArray(spec.passos) || spec.passos.length === 0) return { ok: false, erro: "sem_passos" };
  const tipos = new Set(["auth", "http", "poll", "extract"]);
  for (const p of spec.passos) {
    if (!tipos.has((p as { tipo: string }).tipo)) return { ok: false, erro: `passo_invalido:${(p as { tipo: string }).tipo}` };
  }
  return { ok: true };
}

function montarTexto(resultados: ResultadoCotacaoItem[]): { texto: string; maisBarata: ResultadoCotacaoItem | null } {
  const cotados = resultados.filter((r) => r.status === "cotado" && r.premio_total > 0).sort((a, b) => a.premio_total - b.premio_total);
  if (cotados.length === 0) return { texto: "Nenhuma seguradora retornou oferta no momento.", maisBarata: null };
  const linhas = cotados
    .slice(0, 5)
    .map((r) => `• ${r.seguradora}: R$ ${r.premio_total.toFixed(2)}${r.parcelas > 1 ? ` em ${r.parcelas}x` : ""}`);
  return { texto: linhas.join("\n"), maisBarata: cotados[0] ?? null };
}

/**
 * Cria um `QuoteProvider` a partir de uma `AdapterSpec` aprovada+ativa.
 * `nome` = `adapter:<sistema>:<ramo>` para distinguir nos logs/registry.
 */
export function criarAdapterProvider(spec: AdapterSpec, deps: RunnerDeps): QuoteProvider {
  const circuit = deps.circuit ?? new CircuitBreaker();
  return {
    nome: `adapter:${spec.sistema}:${spec.ramo}`,
    automatizado: true,
    async cotar(ctx: QuoteContext, persist?: PersistencePort, onIniciada?: (id: string) => void): Promise<QuoteResult | null> {
      const val = validarSpec(spec);
      if (!val.ok) return null;

      const dados = ctx.dados ?? {};
      const faltando = spec.entradaObrigatoria.filter((k) => dados[k] == null || dados[k] === "");
      const chaveCircuito = `${ctx.corretoraId ?? "seed"}:${spec.sistema}`;
      const idem = hashDados(dados);

      if (faltando.length > 0) {
        await persist?.registrarLog({ operacao: "cotacao", via: "api", sucesso: false, detalhe: { adapter: spec.sistema, faltando, idem } });
        return null;
      }
      if (circuit.aberto(chaveCircuito)) {
        await persist?.registrarLog({ operacao: "cotacao", via: "api", sucesso: false, detalhe: { adapter: spec.sistema, motivo: "circuit_aberto", idem } });
        return null;
      }

      let cotacaoId: string | null = null;
      try {
        const ini = await persist?.iniciarCotacao({
          conversaId: ctx.conversaId,
          clienteId: ctx.clienteId,
          ramo: spec.ramo,
          dadosEntrada: dados,
          origem: ctx.origem,
        });
        cotacaoId = ini?.cotacaoId ?? null;
        if (cotacaoId) onIniciada?.(cotacaoId);

        const vars: Record<string, unknown> = { ...dados };
        let ultimaResp: unknown = null;
        let arrayEmCorrente = "resultados";

        for (const passo of spec.passos) {
          if (passo.tipo === "auth") {
            const p = passo as PassoAuth;
            await persist?.registrarEtapa({ cotacaoId, conversaId: ctx.conversaId, etapa: "token", status: "andamento" });
            const corpo: Record<string, string> = {};
            for (const [k, v] of Object.entries(p.corpo)) corpo[k] = aplicarTemplate(v, vars);
            const r = await chamarHttp(deps, { metodo: "POST", url: aplicarTemplate(p.url, vars), corpo }, spec);
            vars[p.guardarEm ?? "token"] = lerCaminho(r.corpo, p.tokenPath);
            await persist?.registrarEtapa({ cotacaoId, conversaId: ctx.conversaId, etapa: "token", status: "ok" });
          } else if (passo.tipo === "http") {
            const p = passo as PassoHttp;
            const headers = aplicarTemplateObj(p.headers, vars);
            const corpo =
              typeof p.corpo === "string"
                ? aplicarTemplate(p.corpo, vars)
                : p.corpo
                  ? Object.fromEntries(Object.entries(p.corpo).map(([k, v]) => [k, aplicarTemplate(v, vars)]))
                  : undefined;
            const r = await chamarHttp(deps, { metodo: p.metodo, url: aplicarTemplate(p.url, vars), headers, corpo }, spec);
            ultimaResp = r.corpo;
            for (const [nome, cam] of Object.entries(p.extrair ?? {})) vars[nome] = lerCaminho(r.corpo, cam);
            await persist?.registrarEtapa({ cotacaoId, conversaId: ctx.conversaId, etapa: "calculo", status: "ok" });
          } else if (passo.tipo === "poll") {
            const p = passo as PassoPoll;
            const headers = aplicarTemplateObj(p.headers, vars);
            const limite = Date.now() + p.timeoutMs;
            await persist?.registrarEtapa({ cotacaoId, conversaId: ctx.conversaId, etapa: "coleta", status: "andamento" });
            // localiza o arrayEm que o extract usará (se houver), p/ avaliar prontidão
            const ext = spec.passos.find((x) => x.tipo === "extract") as PassoExtract | undefined;
            arrayEmCorrente = ext?.arrayEm ?? arrayEmCorrente;
            let pronto = false;
            while (Date.now() < limite) {
              const r = await chamarHttp(deps, { metodo: p.metodo, url: aplicarTemplate(p.url, vars), headers }, spec);
              ultimaResp = r.corpo;
              if (estaPronto(r.corpo, p.prontoQuando, arrayEmCorrente)) {
                pronto = true;
                break;
              }
              await (deps.sleep ?? sleepReal)(p.intervaloMs);
            }
            await persist?.registrarEtapa({ cotacaoId, conversaId: ctx.conversaId, etapa: "coleta", status: pronto ? "ok" : "erro" });
          } else if (passo.tipo === "extract") {
            const resultados = extrair(ultimaResp, passo as PassoExtract);
            const { texto, maisBarata } = montarTexto(resultados);
            await persist?.atualizarCotacao(cotacaoId ?? "", {
              status: "concluida",
              resultados,
              validadeAte: new Date(Date.now() + 24 * 3600_000).toISOString(),
            });
            circuit.sucesso(chaveCircuito);
            return { texto, cotacaoId, maisBarata };
          }
        }

        // sem passo extract → nada utilizável
        circuit.sucesso(chaveCircuito);
        await persist?.atualizarCotacao(cotacaoId ?? "", { status: "erro" });
        return null;
      } catch (e) {
        circuit.falha(chaveCircuito);
        await persist?.registrarLog({
          operacao: "cotacao",
          via: "api",
          sucesso: false,
          detalhe: { adapter: spec.sistema, erro: e instanceof Error ? e.message : "erro", idem },
        });
        if (cotacaoId) await persist?.atualizarCotacao(cotacaoId, { status: "erro" });
        return null;
      }
    },
  };
}
