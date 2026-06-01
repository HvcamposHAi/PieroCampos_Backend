/**
 * Validação/normalização de telefone BR (usado quando o cliente informa ou o
 * operador edita — o número de ENVIO é o wa_jid, separado disto).
 */
import { describe, it, expect } from "vitest";
import { normalizarTelefoneBr, telefoneBrValido } from "../src/lib/telefone";

describe("normalizarTelefoneBr", () => {
  it("celular com DDD (11 dígitos) → +55…", () => {
    expect(normalizarTelefoneBr("41996247863")).toBe("+5541996247863");
    expect(normalizarTelefoneBr("(41) 99624-7863")).toBe("+5541996247863");
  });

  it("já com DDI 55 (13 dígitos) mantém", () => {
    expect(normalizarTelefoneBr("+55 41 99624-7863")).toBe("+5541996247863");
    expect(normalizarTelefoneBr("5541996247863")).toBe("+5541996247863");
  });

  it("fixo (10 dígitos) → +55…", () => {
    expect(normalizarTelefoneBr("4133221100")).toBe("+554133221100");
  });

  it("remove 0 de discagem à esquerda (0 + DDD + 9 dígitos)", () => {
    expect(normalizarTelefoneBr("041996247863")).toBe("+5541996247863");
  });

  it("rejeita LID-garbage / DDI estrangeiro", () => {
    expect(normalizarTelefoneBr("+23716993970200")).toBeNull(); // não é BR
    expect(normalizarTelefoneBr("23716993970200")).toBeNull();
  });

  it("rejeita DDD inválido e celular (9 díg) sem o 9 inicial", () => {
    expect(normalizarTelefoneBr("0096247863")).toBeNull(); // DDD 00
    expect(normalizarTelefoneBr("41812345678")).toBeNull(); // assinante 9 díg começando com 8
  });

  it("aceita fixo de 10 dígitos (assinante de 8)", () => {
    expect(normalizarTelefoneBr("4133221100")).toBe("+554133221100");
  });

  it("vazio/curto → null", () => {
    expect(normalizarTelefoneBr("")).toBeNull();
    expect(normalizarTelefoneBr("123")).toBeNull();
  });

  it("telefoneBrValido reflete a normalização", () => {
    expect(telefoneBrValido("41996247863")).toBe(true);
    expect(telefoneBrValido("+23716993970200")).toBe(false);
  });
});
