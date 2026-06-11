/**
 * Camada HTTP do Aggilizador: política de RETRY/BACKOFF.
 * Repete transitórios (rede/5xx/429/403-sem-corpo); NÃO repete erro de negócio
 * (400/401/422/403-com-corpo). Usa fake timers para não esperar o backoff real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import axios from "axios";
import { aggilizadorRequest } from "../src/integrations/aggilizador/aggilizador.http";

/** Monta um erro no formato AxiosError (isAxiosError:true). */
function axErr(status?: number, data?: unknown, code?: string) {
  return {
    isAxiosError: true,
    code,
    message: "erro",
    response: status === undefined ? undefined : { status, data, headers: {} },
  };
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.useRealTimers());

describe("aggilizadorRequest — retry/backoff", () => {
  it("5xx transitório → repete e tem sucesso", async () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(axios, "request")
      .mockRejectedValueOnce(axErr(503))
      .mockResolvedValueOnce({ data: { ok: true } } as never);
    const p = aggilizadorRequest<{ ok: boolean }>({ method: "GET", url: "https://x/test" });
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.data.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("erro de rede (sem resposta) → repete", async () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(axios, "request")
      .mockRejectedValueOnce(axErr(undefined, undefined, "ECONNRESET"))
      .mockResolvedValueOnce({ data: 1 } as never);
    const p = aggilizadorRequest({ method: "GET", url: "https://x" });
    await vi.runAllTimersAsync();
    await p;
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("429 rate-limit → repete", async () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(axios, "request")
      .mockRejectedValueOnce(axErr(429))
      .mockResolvedValueOnce({ data: 1 } as never);
    const p = aggilizadorRequest({ method: "GET", url: "https://x" });
    await vi.runAllTimersAsync();
    await p;
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("403 SEM corpo (borda/WAF) → transitório, esgota as tentativas", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(axios, "request").mockRejectedValue(axErr(403, undefined));
    const p = aggilizadorRequest({ method: "POST", url: "https://x/pdocs" }).catch((e) => e);
    await vi.runAllTimersAsync();
    await p;
    expect(spy).toHaveBeenCalledTimes(3); // MAX_TENTATIVAS
  });

  it("400 de negócio → NÃO repete (falha imediata)", async () => {
    const spy = vi.spyOn(axios, "request").mockRejectedValue(axErr(400, { message: "ruim" }));
    await expect(aggilizadorRequest({ method: "POST", url: "https://x" })).rejects.toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("401 credencial → NÃO repete", async () => {
    const spy = vi.spyOn(axios, "request").mockRejectedValue(axErr(401));
    await expect(aggilizadorRequest({ method: "GET", url: "https://x" })).rejects.toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("403 COM corpo (rejeição explícita do app) → NÃO repete", async () => {
    const spy = vi.spyOn(axios, "request").mockRejectedValue(axErr(403, { message: "forbidden" }));
    await expect(aggilizadorRequest({ method: "GET", url: "https://x" })).rejects.toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
