/**
 * montarPayloadCalculo — shape do calcularV2 (causa-raiz do 502).
 * O probe (13/06) provou: `automovel` singular → 502; `automoveis[]` + condutor +
 * campos de topo + negocio:null → 201. Este teste trava esse contrato.
 */
import { describe, it, expect } from "vitest";
import { montarPayloadCalculo } from "../src/integrations/aggilizador/aggilizador.multicalculo";
import type {
  AutomovelPayload,
  CalculoSeguradora,
  SeguradoPayload,
} from "../src/integrations/aggilizador/aggilizador.types";
import type { EntradaAggilizador } from "../src/integrations/aggilizador/aggilizador.mapper";

const segurado: SeguradoPayload = {
  nome: "FULANO DE TAL",
  tipoPessoa: "F",
  cpfCnpj: "02931285960",
  estadoCivil: 3,
  dataNasc: "1980-11-03T00:00:00.000Z",
  sexo: "M",
  fone1: "41999990000",
  cep: "81220190",
  email: "f@x.com",
  uf: "PR",
  cidade: "Curitiba",
  bairro: "Centro",
  logradouro: "Rua X",
  isPCD: false,
};
const veiculo: AutomovelPayload = {
  fipe: "0251569",
  anoMod: "2012",
  anoFab: "2012",
  placa: "AVJ1548",
  tipoVeic: "v",
  chassi: "93YBSR8VKCJ294594",
  modelo: "SANDERO STEPWAY HI-FLEX 1.6 16V 5P",
  codFabr: 48,
  valorDeNovo: 0,
};
const entrada: EntradaAggilizador = {
  cpf: "02931285960",
  placa: "AVJ1548",
  cep: "81220190",
  estadoCivilCodigo: 3,
  zeroKm: false,
};
const calculos = [{ nome: "Porto", seguradora: 8 }] as unknown as CalculoSeguradora[];

describe("montarPayloadCalculo", () => {
  const p = montarPayloadCalculo(segurado, calculos, veiculo, entrada);

  it("usa automoveis[] (NÃO automovel singular) — o que evita o 502", () => {
    expect(Array.isArray(p.cotacao.automoveis)).toBe(true);
    expect(p.cotacao.automoveis).toHaveLength(1);
    expect((p.cotacao as Record<string, unknown>).automovel).toBeUndefined();
  });

  it("o carro carrega o condutor PRINCIPAL = segurado", () => {
    const c = p.cotacao.automoveis[0]!.condutores[0]!;
    expect(c.principal).toBe(true);
    expect(c.cpfCnpj).toBe("02931285960");
    expect(c.nome).toBe("FULANO DE TAL");
    expect(c.sexo).toBe("M");
    expect(c.estadoCivil).toBe(3);
    expect(c.relacComSegurado).toBe(1);
  });

  it("carro: descricao/fabricante/fipe/placa/ano vêm do veículo; defaults neutros", () => {
    const carro = p.cotacao.automoveis[0]!;
    expect(carro.descricao).toBe("SANDERO STEPWAY HI-FLEX 1.6 16V 5P");
    expect(carro.fabricante).toBe(48);
    expect(carro.fipe).toBe("0251569");
    expect(carro.placa).toBe("AVJ1548");
    expect(carro.anoFabricacao).toBe(2012);
    expect(carro.anoModelo).toBe(2012);
    expect(carro.tipo).toBe("v");
    expect(carro.tpUso).toBe(1);
    expect(carro.cepPernoite).toBe("81220190");
  });

  it("campos de TOPO obrigatórios presentes (tipo/ramo/tpCobertura/vigência) + negocio:null", () => {
    expect(p.cotacao.tipo).toBe(5);
    expect(p.cotacao.ramo).toBe(31);
    expect(p.cotacao.tpCobertura).toBe(1);
    expect(p.cotacao.integracaoInfo).toBe(1);
    expect(p.cotacao.renovacao).toBe(false);
    expect(typeof p.cotacao.vigenciaIni).toBe("string");
    expect(typeof p.cotacao.vigenciaFim).toBe("string");
    expect(new Date(p.cotacao.vigenciaFim).getFullYear() - new Date(p.cotacao.vigenciaIni).getFullYear()).toBe(1);
    expect(p.cotacao.results.main).toEqual({ errors: [], successes: [] });
    expect(p.negocio).toBeNull();
  });

  it("propaga calculos e segurado", () => {
    expect(p.cotacao.calculos).toBe(calculos);
    expect(p.cotacao.segurado).toBe(segurado);
  });
});
