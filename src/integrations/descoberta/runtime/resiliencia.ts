/**
 * Resiliência do runner: retry com backoff exponencial + jitter e circuit
 * breaker por chave (corretora,sistema). PURO o suficiente p/ teste (injeta
 * `sleep` e `agora`). 4xx = fail-fast; 5xx/timeout/erro de rede = retry.
 */

export class ErroHttp extends Error {
  constructor(
    readonly status: number,
    msg?: string,
  ) {
    super(msg ?? `HTTP ${status}`);
    this.name = "ErroHttp";
  }
}

/** 4xx (exceto 429) não deve ser re-tentado. */
export function ehRetentavel(e: unknown): boolean {
  if (e instanceof ErroHttp) return e.status === 429 || e.status >= 500;
  return true; // timeout / rede / desconhecido → retentável
}

export interface RetryOpts {
  maxRetries?: number;
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function comRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const max = opts.maxRetries ?? 3;
  const base = opts.baseMs ?? 500;
  const sleep = opts.sleep ?? sleepReal;
  const rand = opts.rand ?? Math.random;
  let ultimo: unknown;
  for (let tentativa = 0; tentativa <= max; tentativa++) {
    try {
      return await fn();
    } catch (e) {
      ultimo = e;
      if (tentativa === max || !ehRetentavel(e)) break;
      const espera = Math.round(base * 2 ** tentativa * (0.5 + rand())); // backoff + jitter
      await sleep(espera);
    }
  }
  throw ultimo;
}

// ── Circuit breaker (in-memory, por chave) ─────────────────────────────────

type EstadoCb = "fechado" | "aberto" | "meio_aberto";

interface RegistroCb {
  estado: EstadoCb;
  falhas: number;
  total: number;
  abertoAte: number;
}

export interface CircuitOpts {
  limiarFalha?: number; // proporção (0..1) p/ abrir
  minAmostras?: number; // só avalia após N amostras
  cooldownMs?: number;
  agora?: () => number;
}

export class CircuitBreaker {
  private mapa = new Map<string, RegistroCb>();
  private readonly limiar: number;
  private readonly minAmostras: number;
  private readonly cooldownMs: number;
  private readonly agora: () => number;

  constructor(opts: CircuitOpts = {}) {
    this.limiar = opts.limiarFalha ?? 0.5;
    this.minAmostras = opts.minAmostras ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.agora = opts.agora ?? Date.now;
  }

  /** true se o circuito está aberto (deve pular a chamada). */
  aberto(chave: string): boolean {
    const r = this.mapa.get(chave);
    if (!r) return false;
    if (r.estado === "aberto") {
      if (this.agora() >= r.abertoAte) {
        r.estado = "meio_aberto";
        return false; // deixa UMA tentativa passar
      }
      return true;
    }
    return false;
  }

  sucesso(chave: string): void {
    const r = this.mapa.get(chave);
    if (!r) return;
    if (r.estado === "meio_aberto") {
      this.mapa.set(chave, { estado: "fechado", falhas: 0, total: 0, abertoAte: 0 });
    }
  }

  falha(chave: string): void {
    const r = this.mapa.get(chave) ?? { estado: "fechado" as EstadoCb, falhas: 0, total: 0, abertoAte: 0 };
    r.falhas += 1;
    r.total += 1;
    if (r.estado === "meio_aberto" || (r.total >= this.minAmostras && r.falhas / r.total >= this.limiar)) {
      r.estado = "aberto";
      r.abertoAte = this.agora() + this.cooldownMs;
      r.falhas = 0;
      r.total = 0;
    }
    this.mapa.set(chave, r);
  }
}
