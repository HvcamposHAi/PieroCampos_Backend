/** origemPermitida: lista exata + wildcard de subdomínio (preview Workers). */
import { describe, it, expect } from "vitest";
import { origemPermitida } from "../src/app";

const PROD = "https://piero-broker-assist.humberto-320.workers.dev";
const PREVIEW = "https://3eed78fd-piero-broker-assist.humberto-320.workers.dev";
const FRONT = `${PROD},*.humberto-320.workers.dev`;

describe("origemPermitida", () => {
  it("aceita a origem exata de produção", () => {
    expect(origemPermitida(PROD, FRONT)).toBe(true);
  });
  it("aceita preview deploy via wildcard *.humberto-320.workers.dev", () => {
    expect(origemPermitida(PREVIEW, FRONT)).toBe(true);
  });
  it("rejeita origem de outra conta/domínio", () => {
    expect(origemPermitida("https://evil.com", FRONT)).toBe(false);
    // sem ponto antes do sufixo → não casa o wildcard (anti-spoof)
    expect(origemPermitida("https://evilhumberto-320.workers.dev", FRONT)).toBe(false);
  });
  it("requisição sem Origin (curl/healthcheck) passa", () => {
    expect(origemPermitida(undefined, FRONT)).toBe(true);
  });
  it("FRONT_ORIGIN vazio libera tudo (dev)", () => {
    expect(origemPermitida(PREVIEW, "")).toBe(true);
  });
  it('"*" libera tudo', () => {
    expect(origemPermitida("https://qualquer.com", "*")).toBe(true);
  });
});
