import { describe, it, expect } from "vitest";
import { montarContrato } from "./contrato-builder";
import { inferirPremissasLLM, type ClienteLLM } from "./inferencia/premissas.llm";
import { inferirContrato } from "./inferencia/har-para-contrato";
import { analisarSeguranca } from "./inferencia/seguranca.probe";
import type { HarResumo } from "./descoberta.types";

const har: HarResumo = {
  entradas: [
    { metodo: "POST", url: "https://api.x.com/login", status: 200, reqHeaders: {}, reqBody: { email: "[REDACTED]", senha: "[REDACTED]" }, respBody: { data: { token: "[REDACTED]" } } },
    { metodo: "POST", url: "https://api.x.com/cadastros/cliente", status: 200, reqHeaders: { authorization: "[REDACTED]" }, reqBody: { cpf: "123.456.789-00", cep: "01001-000" }, respBody: { id: "s1" } },
  ],
  domLinks: [{ texto: "Auto", href: "/produtos/auto" }],
};

describe("montarContrato (API-Doc)", () => {
  it("produz contrato com OpenAPI 3.1, premissas e x-preconditions", () => {
    const c = montarContrato({ corretoraId: "corr1", sistema: "exemplo", ramo: "auto", har, ramosSuportados: ["auto"] });
    expect(c.status).toBe("rascunho");
    expect((c.openapi as { openapi?: string }).openapi).toBe("3.1.0");
    const pre = (c.openapi as { "x-preconditions"?: Record<string, unknown> })["x-preconditions"];
    expect(pre?.auth_obrigatoria).toBe(true);
    // premissa nº 0 (login+senha) e cpf obrigatório
    expect(c.premissas.some((p) => p.chave === "login_senha_obrigatorio")).toBe(true);
    expect(c.premissas.some((p) => p.chave === "cpf_obrigatorio")).toBe(true);
    // catálogo de seguros detectado
    expect(c.ramosDisponiveis.some((r) => r.ramo === "auto" && r.statusSuporte === "suportado")).toBe(true);
    // segurança: auth sempre obrigatória
    expect((c.seguranca as { auth?: { obrigatorio?: boolean } }).auth?.obrigatorio).toBe(true);
  });

  it("mescla premissas extras (LLM) por chave", () => {
    const c = montarContrato({
      corretoraId: "corr1",
      sistema: "exemplo",
      ramo: "auto",
      har,
      premissasExtras: [{ chave: "rate_limit", valor: "60/min", confianca: 0.7 }],
    });
    expect(c.premissas.some((p) => p.chave === "rate_limit")).toBe(true);
  });
});

describe("inferirPremissasLLM (mock, sem rede)", () => {
  it("retorna premissas da tool e clampa confiança", async () => {
    const cliente: ClienteLLM = {
      messages: {
        create: async () => ({
          content: [{ type: "tool_use", name: "registrar_premissas", input: { premissas: [{ chave: "rate_limit", valor: "60/min", confianca: 5 }] } }],
        }),
      },
    };
    const endpoints = inferirContrato(har).endpoints;
    const seg = analisarSeguranca(har);
    const out = await inferirPremissasLLM({ sistema: "x", ramo: "auto", har, endpoints, seguranca: seg }, { cliente, modelo: "m", maxTokens: 100 });
    expect(out).toEqual([{ chave: "rate_limit", valor: "60/min", confianca: 1 }]);
  });
});
