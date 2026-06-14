// Roteiro por SISTEMA de cotação: garante que o Aggilizador anexa data_nascimento
// + sexo nas categorias auto com sistema (renovacao/seguro_novo), que o Segfy NÃO
// os tem, e que o default (sistema omitido) reproduz byte-a-byte o Segfy (guard de
// não-regressão). Causa-raiz do bug "chave_invalida": validar a chave sem o sistema.
import { describe, it, expect } from "vitest";
import { getRoteiro } from "./roteiros";

const CATEGORIAS_COM_SISTEMA = ["renovacao", "seguro_novo"] as const;
const CAMPOS_AGGILIZADOR = ["data_nascimento", "sexo"] as const;

function chaves(categoria: (typeof CATEGORIAS_COM_SISTEMA)[number], sistema?: string): string[] {
  return (getRoteiro(categoria, "auto", sistema)?.campos ?? []).map((c) => c.chave);
}

describe("roteiro por sistema (Aggilizador vs Segfy)", () => {
  for (const cat of CATEGORIAS_COM_SISTEMA) {
    it(`${cat}: Aggilizador inclui data_nascimento e sexo`, () => {
      const ch = chaves(cat, "aggilizador");
      for (const c of CAMPOS_AGGILIZADOR) expect(ch, `aggilizador/${cat} deveria ter ${c}`).toContain(c);
      // comuns continuam presentes (placa/cpf não dependem de sistema)
      expect(ch).toContain("placa");
      expect(ch).toContain("cpf");
    });

    it(`${cat}: Segfy NÃO inclui data_nascimento/sexo (vêm da API insured)`, () => {
      const ch = chaves(cat, "segfy");
      for (const c of CAMPOS_AGGILIZADOR) expect(ch, `segfy/${cat} não deveria ter ${c}`).not.toContain(c);
    });

    it(`${cat}: sistema omitido == Segfy (retrocompatível, byte-a-byte)`, () => {
      expect(getRoteiro(cat, "auto")).toEqual(getRoteiro(cat, "auto", "segfy"));
    });

    it(`${cat}: sistema desconhecido cai no default (Segfy)`, () => {
      expect(chaves(cat, "sistema_inexistente")).toEqual(chaves(cat, "segfy"));
    });
  }
});
