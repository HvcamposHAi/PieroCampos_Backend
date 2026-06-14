import { describe, it, expect } from "vitest";
import { gerarAdapter } from "./adapter-gen";
import { inferirContrato } from "../inferencia/har-para-contrato";
import type { HarResumo } from "../descoberta.types";

const har: HarResumo = {
  entradas: [
    { metodo: "POST", url: "https://api.x.com/usuario/login", status: 200, reqHeaders: {}, reqBody: { email: "a", senha: "b" }, respBody: { data: { token: "t" } } },
    { metodo: "POST", url: "https://api.x.com/calculo/calcularV2", status: 200, reqHeaders: { authorization: "z" }, reqBody: { cpf: "123.456.789-00", placa: "ABC1D23" }, respBody: { id: "c9" } },
    { metodo: "GET", url: "https://api.x.com/calculo/status/c9", status: 200, reqHeaders: { authorization: "z" }, respBody: { resultados: [{ seguradora: "X", premio: 10, retorno: true }] } },
  ],
};

describe("gerarAdapter", () => {
  it("gera passos auth→http→poll→extract e entradaObrigatoria", () => {
    const spec = gerarAdapter({ contrato: inferirContrato(har), sistema: "exemplo", ramo: "auto" });
    const tipos = spec.passos.map((p) => p.tipo);
    expect(tipos).toContain("auth");
    expect(tipos).toContain("http");
    expect(tipos).toContain("poll");
    expect(tipos).toContain("extract");
    expect(spec.entradaObrigatoria).toEqual(expect.arrayContaining(["cpf", "placa"]));
    // o passo de calcular recebe header Bearer com o token capturado no auth
    const http = spec.passos.find((p) => p.tipo === "http");
    expect(JSON.stringify(http)).toContain("Bearer {{token}}");
  });
});
