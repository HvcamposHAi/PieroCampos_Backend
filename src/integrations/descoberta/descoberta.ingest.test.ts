import { describe, it, expect, vi } from "vitest";
import { ingerirDescoberta } from "./descoberta.ingest";
import type { HarResumo } from "./descoberta.types";

const har: HarResumo = {
  entradas: [
    { metodo: "POST", url: "https://api.x.com/login", status: 200, reqHeaders: {}, reqBody: { email: "[REDACTED]", senha: "[REDACTED]" }, respBody: { data: { token: "[REDACTED]" } } },
    { metodo: "POST", url: "https://api.x.com/calcularV2", status: 200, reqHeaders: { authorization: "[REDACTED]" }, reqBody: { cpf: "123.456.789-00", placa: "ABC1D23" }, respBody: { id: "c1" } },
    { metodo: "GET", url: "https://api.x.com/status/c1", status: 200, reqHeaders: { authorization: "[REDACTED]" }, respBody: { resultados: [{ seguradora: "X", premio: 10, retorno: true }] } },
  ],
  domLinks: [{ texto: "Auto", href: "/produtos/auto" }],
};

describe("ingerirDescoberta", () => {
  it("monta contrato + gera adapter + persiste (sem LLM, sem rede)", async () => {
    const salvarContrato = vi.fn(async () => ({ contratoId: "ct1", versao: 3 }));
    const salvarAdapter = vi.fn(async () => ({ adapterId: "ad1" }));
    const r = await ingerirDescoberta(
      { corretoraId: "corr1", sistema: "exemplo", ramo: "auto", har, ramosSuportados: ["auto"], usarLLM: false },
      { salvarContrato, salvarAdapter },
    );
    expect(r.contratoId).toBe("ct1");
    expect(r.adapterId).toBe("ad1");
    expect(r.versao).toBe(3);
    // contrato tem premissas (login+senha, cpf) e ramos detectados
    expect(r.contrato.premissas.some((p) => p.chave === "cpf_obrigatorio")).toBe(true);
    expect(r.contrato.ramosDisponiveis.some((x) => x.ramo === "auto")).toBe(true);
    // adapter salvo com a versão do contrato e passos declarativos
    expect(salvarAdapter).toHaveBeenCalledOnce();
    const specArg = salvarAdapter.mock.calls[0]![2] as { versao: number; passos: unknown[] };
    expect(specArg.versao).toBe(3);
    expect(specArg.passos.length).toBeGreaterThan(0);
  });

  it("usa premissas do LLM injetado (mock) quando usarLLM", async () => {
    const inferirPremissasLLM = vi.fn(async () => [{ chave: "rate_limit", valor: "60/min", confianca: 0.8 }]);
    const r = await ingerirDescoberta(
      { corretoraId: "corr1", sistema: "exemplo", ramo: "auto", har, usarLLM: true },
      {
        inferirPremissasLLM: inferirPremissasLLM as never,
        salvarContrato: async () => ({ contratoId: "ct2", versao: 1 }),
        salvarAdapter: async () => ({ adapterId: "ad2" }),
      },
    );
    expect(inferirPremissasLLM).toHaveBeenCalledOnce();
    expect(r.contrato.premissas.some((p) => p.chave === "rate_limit")).toBe(true);
  });
});
