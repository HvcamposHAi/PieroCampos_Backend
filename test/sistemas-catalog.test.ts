/**
 * Catálogo único de sistemas de cotação — fonte de verdade p/ N sistemas.
 * Mocka as funções de login/sessão (evita carregar rede) e valida:
 * sistemaValido/getSistema, a forma pública (com `exige2fa`) e que cada sistema
 * automatizado expõe um provider. O teste de conexão despacha por sistema.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/integrations/segfy/segfy.multicalculo", () => ({ obterTokensSegfy: vi.fn(async () => ({})) }));
vi.mock("../src/services/segfy-sessao.service", () => ({ restaurarSessao: vi.fn(async () => null) }));
vi.mock("../src/integrations/aggilizador/aggilizador.auth", () => ({ loginAggilizador: vi.fn(async () => ({})) }));

import {
  SISTEMAS,
  SISTEMAS_PUBLICOS,
  SISTEMA_PADRAO,
  sistemaValido,
  getSistema,
} from "../src/integrations/quote/sistemas.catalog";

describe("sistemas.catalog", () => {
  it("sistemaValido reconhece os do catálogo e rejeita desconhecidos", () => {
    expect(sistemaValido("segfy")).toBe(true);
    expect(sistemaValido("aggilizador")).toBe(true);
    expect(sistemaValido("xpto")).toBe(false);
    expect(sistemaValido("")).toBe(false);
  });

  it("getSistema retorna a entrada (ou undefined)", () => {
    expect(getSistema("segfy")?.id).toBe("segfy");
    expect(getSistema("xpto")).toBeUndefined();
    expect(getSistema(null)).toBeUndefined();
    expect(getSistema(undefined)).toBeUndefined();
  });

  it("SISTEMA_PADRAO é um sistema válido", () => {
    expect(sistemaValido(SISTEMA_PADRAO)).toBe(true);
  });

  it("forma pública expõe exige2fa e NÃO vaza testarConexao", () => {
    const segfy = SISTEMAS_PUBLICOS.find((s) => s.id === "segfy")!;
    const agg = SISTEMAS_PUBLICOS.find((s) => s.id === "aggilizador")!;
    expect(segfy.exige2fa).toBe(true); // Segfy usa 2FA/sessão
    expect(agg.exige2fa).toBe(false); // Aggilizador é stateless
    expect(segfy.automatizado).toBe(true);
    expect(agg.automatizado).toBe(true);
    expect((segfy as Record<string, unknown>).testarConexao).toBeUndefined();
    expect((segfy as Record<string, unknown>).provider).toBeUndefined();
  });

  it("todo sistema automatizado tem um provider", () => {
    for (const s of Object.values(SISTEMAS)) {
      if (s.automatizado) expect(typeof s.provider?.nome).toBe("string");
    }
  });

  it("testarConexao despacha p/ o login do sistema (mensagem por sistema)", async () => {
    expect(await getSistema("segfy")!.testarConexao({ email: "a@b.c", password: "x" })).toMatch(/Segfy/);
    expect(await getSistema("aggilizador")!.testarConexao({ email: "a@b.c", password: "x" })).toMatch(/Aggilizador/);
  });
});
