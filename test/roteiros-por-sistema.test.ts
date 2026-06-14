/**
 * Roteiros do ramo AUTO por SISTEMA de cotação (Segfy vs Aggilizador).
 * - default = segfy reproduz o roteiro de hoje (paridade).
 * - aggilizador NÃO tem questionário, mas exige data_nascimento + sexo.
 * - CHAVES_VALIDAS é superset (aceita os campos de todos os sistemas).
 */
import { describe, it, expect } from "vitest";
import {
  getRoteiro,
  getCatalogoCampos,
  calcularProgresso,
  CHAVES_VALIDAS,
  SISTEMA_CAMPOS_PADRAO,
} from "../src/lib/roteiros";

const chaves = (cat: "renovacao" | "seguro_novo", sistema?: string) =>
  (getRoteiro(cat, "auto", sistema)?.campos ?? []).map((c) => c.chave);

describe("getRoteiro por sistema (auto)", () => {
  it("default == segfy (paridade: questionário presente, sem nasc/sexo)", () => {
    expect(SISTEMA_CAMPOS_PADRAO).toBe("segfy");
    const defaultCampos = JSON.stringify(getRoteiro("renovacao", "auto")?.campos);
    const segfyCampos = JSON.stringify(getRoteiro("renovacao", "auto", "segfy")?.campos);
    expect(defaultCampos).toBe(segfyCampos);
    const ch = chaves("renovacao", "segfy");
    expect(ch).toContain("cpf");
    expect(ch).toContain("placa");
    expect(ch).toContain("profissao");
    expect(ch).toContain("garagem");
    expect(ch).toContain("km_mes");
    expect(ch).not.toContain("data_nascimento");
    expect(ch).not.toContain("sexo");
  });

  it("aggilizador: cpf+placa+data_nascimento+sexo (obrig), SEM questionário/profissao", () => {
    const r = getRoteiro("seguro_novo", "auto", "aggilizador")!;
    const ch = r.campos.map((c) => c.chave);
    expect(ch).toContain("cpf");
    expect(ch).toContain("placa");
    expect(ch).toContain("data_nascimento");
    expect(ch).toContain("sexo");
    expect(ch).toContain("estado_civil"); // do bloco comercial
    expect(ch).not.toContain("profissao");
    expect(ch).not.toContain("garagem");
    expect(ch).not.toContain("km_mes");
    expect(ch).not.toContain("condutor_jovem");
    // Aggilizador decodifica o veículo pela PLACA e não usa dados_veiculo_fipe/rg:
    // removidos do roteiro (não pedidos) — o Segfy os mantém.
    expect(ch).not.toContain("dados_veiculo_fipe");
    expect(ch).not.toContain("rg");
    const segNovo = getRoteiro("seguro_novo", "auto", "segfy")!.campos.map((c) => c.chave);
    expect(segNovo).toContain("dados_veiculo_fipe");
    expect(segNovo).toContain("rg");
    // obrigatoriedade
    const obrig = (k: string) => r.campos.find((c) => c.chave === k)?.obrigatorio;
    expect(obrig("data_nascimento")).toBe(true);
    expect(obrig("sexo")).toBe(true);
  });

  it("endosso/nao_renovado NÃO recebem bloco de sistema (mesma coisa em qualquer sistema)", () => {
    const seg = JSON.stringify(getRoteiro("endosso", "auto", "segfy")?.campos);
    const agg = JSON.stringify(getRoteiro("endosso", "auto", "aggilizador")?.campos);
    expect(seg).toBe(agg);
    expect(chaves("renovacao", "aggilizador")).not.toContain("profissao"); // só sanity
  });

  it("sistema desconhecido → cai no default (segfy)", () => {
    const xpto = JSON.stringify(getRoteiro("renovacao", "auto", "xpto")?.campos);
    const segfy = JSON.stringify(getRoteiro("renovacao", "auto", "segfy")?.campos);
    expect(xpto).toBe(segfy);
  });

  it("calcularProgresso conta obrigatórios DO sistema", () => {
    const dados = { segurado: "x", email: "a@b.c", cpf: "1", placa: "ABC1234", cep: "1", numero: "1", estado_civil: "casado", utilizacao_veiculo: "passeio", dados_veiculo_fipe: "x" };
    const agg = calcularProgresso("renovacao", dados, "auto", "aggilizador");
    const seg = calcularProgresso("renovacao", dados, "auto", "segfy");
    // Aggilizador ainda falta data_nascimento + sexo (obrig); Segfy falta profissao (obrig)
    expect(agg.pendentesObrigatorios.map((c) => c.chave)).toEqual(
      expect.arrayContaining(["data_nascimento", "sexo"]),
    );
    expect(seg.pendentesObrigatorios.map((c) => c.chave)).toContain("profissao");
    // Aggilizador não conta dados_veiculo_fipe (removido); Segfy conta.
    expect(agg.pendentesObrigatorios.map((c) => c.chave)).not.toContain("dados_veiculo_fipe");
    const dadosSemFipe = { ...dados, dados_veiculo_fipe: "" };
    const segSemFipe = calcularProgresso("renovacao", dadosSemFipe, "auto", "segfy");
    expect(segSemFipe.pendentesObrigatorios.map((c) => c.chave)).toContain("dados_veiculo_fipe");
  });

  it("getCatalogoCampos reflete o sistema", () => {
    const cat = getCatalogoCampos("auto", "aggilizador");
    const segNovo = cat.find((c) => c.id === "seguro_novo")!;
    const ch = segNovo.campos.map((c) => c.chave);
    expect(ch).toContain("sexo");
    expect(ch).not.toContain("garagem");
  });

  it("CHAVES_VALIDAS é superset (aceita campos de todos os sistemas)", () => {
    expect(CHAVES_VALIDAS.has("data_nascimento")).toBe(true);
    expect(CHAVES_VALIDAS.has("sexo")).toBe(true);
    expect(CHAVES_VALIDAS.has("profissao")).toBe(true);
    expect(CHAVES_VALIDAS.has("km_mes")).toBe(true);
  });
});
