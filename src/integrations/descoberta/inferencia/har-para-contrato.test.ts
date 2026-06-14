import { describe, it, expect } from "vitest";
import { inferirContrato } from "./har-para-contrato";
import type { HarResumo } from "../descoberta.types";

/** HAR resumido inspirado no fluxo real do Aggilizador (token→criar→calcular→poll). */
const har: HarResumo = {
  entradas: [
    { metodo: "GET", url: "https://app.exemplo.com/style.css", status: 200, reqHeaders: {} },
    {
      metodo: "POST",
      url: "https://api-prod.exemplo.com/usuario/login",
      status: 200,
      reqHeaders: { "content-type": "application/json" },
      reqBody: { email: "[REDACTED]", senha: "[REDACTED]" },
      respBody: { data: { token: "[REDACTED]" }, success: true },
    },
    {
      metodo: "POST",
      url: "https://api-prod.exemplo.com/cadastros/cliente",
      status: 200,
      reqHeaders: { authorization: "[REDACTED]" },
      reqBody: { cpf: "123.456.789-00", nome: "[REDACTED]", cep: "01001-000" },
      respBody: { id: "seg_1" },
    },
    {
      metodo: "POST",
      url: "https://api-prod.exemplo.com/calculo/calcularV2",
      status: 200,
      reqHeaders: { authorization: "[REDACTED]" },
      reqBody: { placa: "ABC1D23", idIntegracao: 0 },
      respBody: { id: "calc_9", versao: 1 },
    },
    {
      metodo: "GET",
      url: "https://api-prod.exemplo.com/calculo/cotacao/calculos/calc_9/1",
      status: 200,
      reqHeaders: { authorization: "[REDACTED]" },
      respBody: { resultados: [{ seguradora: "X", premio: 1200, retorno: true }] },
    },
  ],
};

describe("inferirContrato", () => {
  it("detecta urlBase, endpoints e papéis (auth/criar/calcular/poll)", () => {
    const c = inferirContrato(har);
    expect(c.urlBase).toBe("https://api-prod.exemplo.com");
    // estáticos (css) são ignorados
    expect(c.endpoints.some((e) => e.pathTemplate.endsWith(".css"))).toBe(false);
    const papeis = c.endpoints.map((e) => e.papel);
    expect(papeis).toContain("auth");
    expect(papeis).toContain("criar");
    expect(papeis).toContain("calcular");
    expect(papeis).toContain("poll");
  });

  it("faz path-templating conservador de ids numéricos no caminho do poll", () => {
    const c = inferirContrato(har);
    const poll = c.endpoints.find((e) => e.papel === "poll");
    // só segmentos claramente-id (número puro/uuid/hash) viram {id}; slugs como
    // 'calc_9' são preservados (conservador, evita templatizar caminho real).
    expect(poll?.pathTemplate).toBe("/calculo/cotacao/calculos/calc_9/{id}");
  });

  it("marca CPF como campo obrigatório com pattern", () => {
    const c = inferirContrato(har);
    const criar = c.endpoints.find((e) => e.papel === "criar");
    const cpf = criar?.campos.find((x) => x.nome === "cpf");
    expect(cpf?.obrigatorio).toBe(true);
    expect(cpf?.pattern).toMatch(/\\d\{3\}/);
  });

  it("detecta auth Bearer pelo header authorization", () => {
    const c = inferirContrato(har);
    const calc = c.endpoints.find((e) => e.papel === "calcular");
    expect(calc?.auth).toBe("bearer");
  });
});
