// Contrato de catálogo dos roteiros — pinado ao MESMO contrato do front
// (piero-broker-assist/src/lib/bot-scripts.test.ts → CONTRATO_CATALOGO).
// Ambos os lados travam o drift contra esta tabela; mudar um roteiro exige
// atualizar os dois arquivos juntos. Categorias usam o ENUM do banco.
import { describe, it, expect } from "vitest";
import { getCatalogoCampos, CHAVES_VALIDAS } from "./roteiros";

// Roteiro EFETIVO do sistema default (segfy): o bloco de campos por sistema é
// composto em getRoteiro/getCatalogoCampos, então o contrato (que inclui o
// questionário Segfy) é validado contra a saída COMPOSTA, não o objeto base.
const CATALOGO_SEGFY = getCatalogoCampos();

const SEGFY: Record<string, boolean> = {
  cpf: true,
  placa: true,
  profissao: true,
  garagem: false,
  trabalha: false,
  garagem_trabalho: false,
  estuda: false,
  garagem_estudo: false,
  km_mes: false,
  distancia_trabalho: false,
  tipo_residencia: false,
  condutor_jovem: false,
  sexo_condutor_jovem: false,
  idade_condutor_secundario: false,
};

const CONTRATO: Record<string, Record<string, boolean>> = {
  renovacao: {
    segurado: true,
    corretor: false,
    comissao: false,
    alteracao: false,
    telefone: false,
    email: true,
    utilizacao_veiculo: true,
    dados_veiculo_fipe: true,
    bonus: false,
    estado_civil: true,
    cep: true,
    numero: true,
    complemento: false,
    ...SEGFY,
  },
  seguro_novo: {
    segurado: true,
    estado_civil: true,
    cep: true,
    numero: true,
    complemento: false,
    corretor: false,
    comissao: false,
    utilizacao_veiculo: true,
    email: true,
    telefone_contato: false,
    rg: true,
    dados_veiculo_fipe: true,
    renovacao_outro_corretor: false,
    bonus: false,
    ...SEGFY,
  },
  endosso: {
    segurado: true,
    corretor: false,
    alteracao: true,
    utilizacao_veiculo: false,
    seguradora: true,
    restituicao: false,
  },
  nao_renovado: {
    segurado: true,
    corretor: false,
    apolice_anterior: true,
    seguradora_anterior: true,
    interesse_regularizar: true,
  },
};

describe("roteiros — contrato de catálogo (paridade com o front)", () => {
  for (const [cat, esperado] of Object.entries(CONTRATO)) {
    it(`'${cat}': chaves e flags obrigatorio conforme o contrato`, () => {
      const roteiro = CATALOGO_SEGFY.find((c) => c.id === cat);
      expect(roteiro, `roteiro ${cat} ausente`).toBeTruthy();
      const real: Record<string, boolean> = {};
      for (const c of roteiro!.campos) real[c.chave] = c.obrigatorio;
      expect(real).toEqual(esperado);
    });
  }

  it("CHAVES_VALIDAS contém todas as chaves do contrato", () => {
    const todas = new Set(Object.values(CONTRATO).flatMap((m) => Object.keys(m)));
    for (const chave of todas) {
      expect(CHAVES_VALIDAS.has(chave), `chave ausente em CHAVES_VALIDAS: ${chave}`).toBe(true);
    }
  });
});
