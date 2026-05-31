/**
 * erroCurto: extrai o MOTIVO REAL do corpo da resposta de erro do Segfy (axios),
 * sem vazar CPF/token, com fallback robusto. Garante que o 422 do /calculate
 * pare de aparecer como "Request failed with status code 422".
 */
import { describe, it, expect } from "vitest";
import { erroCurto } from "../src/integrations/segfy/segfy.multicalculo";

function axiosErro(status: number, data: unknown, message = `Request failed with status code ${status}`) {
  return { isAxiosError: true, message, response: { status, data } };
}

describe("erroCurto", () => {
  it("extrai data.message do 422 com o status", () => {
    const msg = erroCurto(axiosErro(422, { message: "coverage is required" }));
    expect(msg).toContain("HTTP 422");
    expect(msg).toContain("coverage is required");
  });

  it("usa data.errors (objeto) quando não há message", () => {
    const msg = erroCurto(axiosErro(422, { errors: { vehicle: ["invalid fipe"] } }));
    expect(msg).toContain("HTTP 422");
    expect(msg).toContain("invalid fipe");
  });

  it("corpo string vira motivo", () => {
    expect(erroCurto(axiosErro(400, "bad request body"))).toContain("bad request body");
  });

  it("nunca vaza CPF (11 dígitos) presente no corpo", () => {
    const msg = erroCurto(axiosErro(422, { message: "document 09065661930 invalid" }));
    expect(msg).not.toContain("09065661930");
    expect(msg).toContain("***");
  });

  it("erro comum (não-axios) cai no e.message sanitizado", () => {
    expect(erroCurto(new Error("placa não decodificada"))).toBe("placa não decodificada");
  });

  it("corpo em formato inesperado não lança", () => {
    expect(() => erroCurto(axiosErro(500, 12345 as unknown))).not.toThrow();
  });
});
