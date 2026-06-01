// Util de CEP: validação + consulta (ViaCEP primário, BrasilAPI fallback).
// O fetcher é injetado — sem rede.
import { describe, it, expect, vi } from "vitest";
import { cepValido, formatarCep, consultarCep, type CepFetcher } from "../src/lib/cep";

describe("cepValido / formatarCep", () => {
  it("aceita 8 dígitos (com ou sem máscara) e rejeita 7/9", () => {
    expect(cepValido("81270320")).toBe(true);
    expect(cepValido("81270-320")).toBe(true);
    expect(cepValido("8127032")).toBe(false);
    expect(cepValido("812703200")).toBe(false);
    expect(cepValido("")).toBe(false);
  });

  it("formata como 00000-000", () => {
    expect(formatarCep("81270320")).toBe("81270-320");
    expect(formatarCep("81270-320")).toBe("81270-320");
  });
});

const VIACEP_OK = {
  cep: "81270-320",
  logradouro: "Rua João Alencar Guimarães",
  bairro: "Cidade Industrial",
  localidade: "Curitiba",
  uf: "PR",
};

describe("consultarCep", () => {
  it("CEP inválido → null sem consultar", async () => {
    const fetcher = vi.fn();
    expect(await consultarCep("123", { fetcher })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("ViaCEP sucesso → mapeia logradouro/bairro/cidade/uf", async () => {
    const fetcher: CepFetcher = vi.fn(async () => ({ status: 200, data: VIACEP_OK }));
    const r = await consultarCep("81270-320", { fetcher });
    expect(r).toEqual({
      cep: "81270320",
      logradouro: "Rua João Alencar Guimarães",
      bairro: "Cidade Industrial",
      cidade: "Curitiba",
      uf: "PR",
    });
  });

  it("ViaCEP 'erro:true' → cai no BrasilAPI", async () => {
    const fetcher: CepFetcher = vi.fn(async (url) => {
      if (url.includes("viacep")) return { status: 200, data: { erro: true } };
      return { status: 200, data: { street: "Rua X", neighborhood: "Centro", city: "Curitiba", state: "PR" } };
    });
    const r = await consultarCep("81270320", { fetcher });
    expect(r).toEqual({ cep: "81270320", logradouro: "Rua X", bairro: "Centro", cidade: "Curitiba", uf: "PR" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("ViaCEP lança (rede) → fallback BrasilAPI", async () => {
    const fetcher: CepFetcher = vi.fn(async (url) => {
      if (url.includes("viacep")) throw new Error("ECONNRESET");
      return { status: 200, data: { street: "Rua Y", neighborhood: "Bairro", city: "Cidade", state: "SP" } };
    });
    const r = await consultarCep("01310100", { fetcher });
    expect(r?.cidade).toBe("Cidade");
  });

  it("ambos falham → null (nunca lança)", async () => {
    const fetcher: CepFetcher = vi.fn(async (url) => {
      if (url.includes("viacep")) return { status: 200, data: { erro: true } };
      return { status: 404, data: { message: "not found" } };
    });
    expect(await consultarCep("99999999", { fetcher })).toBeNull();
  });
});
