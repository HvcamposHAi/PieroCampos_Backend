// Roteiros multi-ramo: garante que (a) auto segue idêntico quando ramo é omitido,
// (b) ramos não-auto NÃO carregam campos de veículo/Segfy, (c) CHAVES_VALIDAS é
// superset. Complementa o contrato auto em roteiros.test.ts.
import { describe, it, expect } from "vitest";
import {
  getRoteiro,
  getRoteiroEfetivo,
  CHAVES_VALIDAS,
  normalizarRamo,
  ROTEIROS,
} from "./roteiros";

const CAMPOS_AUTO_EXCLUSIVOS = [
  "placa",
  "dados_veiculo_fipe",
  "utilizacao_veiculo",
  "garagem",
  "garagem_trabalho",
  "km_mes",
  "condutor_jovem",
];

describe("roteiros multi-ramo", () => {
  it("ramo omitido = auto (retrocompatível)", () => {
    expect(getRoteiro("renovacao")).toEqual(getRoteiro("renovacao", "auto"));
    expect(getRoteiro("renovacao")).toBe(ROTEIROS.renovacao);
  });

  it("getRoteiroEfetivo('renovacao') sem ramo == saída do auto", () => {
    const semRamo = getRoteiroEfetivo("renovacao");
    const auto = getRoteiroEfetivo("renovacao", [], [], "auto");
    expect(semRamo).toEqual(auto);
  });

  for (const ramo of ["vida", "residencial", "empresarial", "saude"] as const) {
    it(`${ramo}: seguro_novo não tem campos de veículo/Segfy`, () => {
      const roteiro = getRoteiro("seguro_novo", ramo);
      expect(roteiro, `roteiro ${ramo}/seguro_novo ausente`).toBeTruthy();
      const chaves = roteiro!.campos.map((c) => c.chave);
      for (const proibida of CAMPOS_AUTO_EXCLUSIVOS) {
        expect(chaves, `${ramo} não deveria ter ${proibida}`).not.toContain(proibida);
      }
      // mantém os comuns comerciais
      expect(chaves).toContain("segurado");
      expect(chaves).toContain("cep");
    });
  }

  it("CHAVES_VALIDAS contém chaves do auto E dos novos ramos", () => {
    expect(CHAVES_VALIDAS.has("placa")).toBe(true); // auto
    expect(CHAVES_VALIDAS.has("capital_segurado_desejado")).toBe(true); // vida
    expect(CHAVES_VALIDAS.has("tipo_imovel")).toBe(true); // residencial
    expect(CHAVES_VALIDAS.has("cnpj")).toBe(true); // empresarial
    expect(CHAVES_VALIDAS.has("quantidade_vidas")).toBe(true); // saúde
  });

  it("normalizarRamo cai em 'auto' para valores desconhecidos/nulos", () => {
    expect(normalizarRamo(null)).toBe("auto");
    expect(normalizarRamo("inexistente")).toBe("auto");
    expect(normalizarRamo("vida")).toBe("vida");
    expect(normalizarRamo("saude")).toBe("saude");
  });
});
