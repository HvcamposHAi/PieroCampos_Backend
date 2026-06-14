/**
 * Múltiplas cotações por conversa (chaveadas por placa):
 * - limparCamposVeiculo zera SÓ os campos de veículo (mantém os pessoais).
 * - o prompt ganha a variante "novo veículo" (mostra os pessoais, pede a placa).
 * - o prompt avisa quando a placa já foi cotada (confirmar REFAZER).
 */
import { describe, it, expect } from "vitest";
import { CHAVES_VEICULO, limparCamposVeiculo } from "../src/lib/roteiros";
import { buildSystemPromptDinamico } from "../src/lib/system-prompt";

describe("limparCamposVeiculo", () => {
  it("remove só as chaves de veículo, preserva as pessoais", () => {
    const dados = {
      cpf: "123", segurado: "Fulano", email: "a@b.c", estado_civil: "casado",
      data_nascimento: "1980", sexo: "m", cep: "80000", numero: "10",
      placa: "ABC1D23", dados_veiculo_fipe: "Gol 2012", utilizacao_veiculo: "passeio", bonus: "5",
    };
    const out = limparCamposVeiculo(dados);
    // veículo → fora
    expect(out).not.toHaveProperty("placa");
    expect(out).not.toHaveProperty("dados_veiculo_fipe");
    expect(out).not.toHaveProperty("utilizacao_veiculo");
    expect(out).not.toHaveProperty("bonus");
    // pessoais → mantidos
    expect(out.cpf).toBe("123");
    expect(out.segurado).toBe("Fulano");
    expect(out.data_nascimento).toBe("1980");
    expect(out.sexo).toBe("m");
    expect(out.cep).toBe("80000");
  });

  it("CHAVES_VEICULO contém placa e dados_veiculo_fipe, não contém cpf", () => {
    expect(CHAVES_VEICULO.has("placa")).toBe(true);
    expect(CHAVES_VEICULO.has("dados_veiculo_fipe")).toBe(true);
    expect(CHAVES_VEICULO.has("cpf")).toBe(false);
    expect(CHAVES_VEICULO.has("segurado")).toBe(false);
  });
});

describe("system-prompt — variante novo veículo", () => {
  function build(over: Record<string, unknown> = {}) {
    return buildSystemPromptDinamico({
      categoria: "seguro_novo",
      contextoRAG: "",
      dadosColetados: { segurado: "Humberto", cpf: "123", data_nascimento: "1980", sexo: "m" },
      pendentesObrigatorios: [{ chave: "placa", rotulo: "Placa do veículo", obrigatorio: true }],
      proximoCampo: { chave: "placa", rotulo: "Placa do veículo", obrigatorio: true },
      campoForcado: null,
      revisaoPendente: true,
      novoVeiculo: true,
      sistema: "aggilizador",
      ...over,
    } as never);
  }

  it("novoVeiculo=true → fala em NOVO VEÍCULO e pede a placa, sem re-perguntar pessoais", () => {
    const p = build();
    expect(p).toContain("NOVO VEÍCULO");
    expect(p.toLowerCase()).toContain("placa");
    expect(p).toMatch(/dados pessoais/i);
  });

  it("revisão comum (novoVeiculo ausente) → texto de cliente recorrente", () => {
    const p = build({ novoVeiculo: false });
    expect(p).toContain("CLIENTE RECORRENTE");
    expect(p).not.toContain("NOVO VEÍCULO");
  });

  it("placaRepetida na confirmação → instrui confirmar REFAZER", () => {
    const p = buildSystemPromptDinamico({
      categoria: "seguro_novo",
      contextoRAG: "",
      dadosColetados: { placa: "ABC1D23" },
      pendentesObrigatorios: [],
      proximoCampo: null,
      campoForcado: null,
      pedirConfirmacaoCotacao: true,
      placaRepetida: "ABC1D23",
      sistema: "aggilizador",
    } as never);
    expect(p).toMatch(/REFAZER/i);
    expect(p).toContain("ABC1D23");
  });
});
