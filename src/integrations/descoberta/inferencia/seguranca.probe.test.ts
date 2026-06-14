import { describe, it, expect } from "vitest";
import { analisarSeguranca } from "./seguranca.probe";
import type { HarResumo } from "../descoberta.types";

describe("analisarSeguranca", () => {
  it("auth é SEMPRE obrigatório (premissa nº 0) e detecta bearer + TLS", () => {
    const har: HarResumo = {
      entradas: [
        { metodo: "POST", url: "https://api.x.com/login", status: 200, reqHeaders: { authorization: "[REDACTED]" } },
      ],
    };
    const s = analisarSeguranca(har);
    expect(s.auth.obrigatorio).toBe(true);
    expect(s.auth.esquema).toBe("bearer_jwt");
    expect(s.transporte.tlsTudo).toBe(true);
  });

  it("sinaliza HTTP puro como risco de transporte", () => {
    const har: HarResumo = {
      entradas: [{ metodo: "GET", url: "http://inseguro.x.com/api", status: 200, reqHeaders: {} }],
    };
    const s = analisarSeguranca(har);
    expect(s.transporte.tlsTudo).toBe(false);
    expect(s.transporte.httpPuroEm).toContain("http://inseguro.x.com");
  });

  it("detecta captcha (reCAPTCHA) e 2FA pelo markup/sinal", () => {
    const har: HarResumo = { entradas: [] };
    const s = analisarSeguranca(har, { markup: '<script src="https://www.google.com/recaptcha/api.js"></script>', exigiu2fa: true });
    expect(s.captcha.presente).toBe(true);
    expect(s.twoFactor.presente).toBe(true);
  });

  it("coleta PII trafegada e redige por chave", () => {
    const har: HarResumo = {
      entradas: [{ metodo: "POST", url: "https://api.x.com/c", status: 200, reqHeaders: {}, reqBody: { cpf: "x", email: "y" } }],
    };
    const s = analisarSeguranca(har);
    expect(s.piiTrafegada).toEqual(expect.arrayContaining(["cpf", "email"]));
  });
});
