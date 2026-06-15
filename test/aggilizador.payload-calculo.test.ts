/**
 * montarPayloadCalculo — shape do calcularV2 (causa-raiz do 502).
 * O probe (13/06) provou: `automovel` singular → 502; `automoveis[]` + condutor +
 * campos de topo + negocio:null → 201. Este teste trava esse contrato.
 */
import { describe, it, expect } from "vitest";
import {
  montarPayloadCalculo,
  normalizarAnosVeiculo,
  formatarFipeTxt,
  estimarHabilitacao,
  DEFAULTS_AGGILIZADOR,
} from "../src/integrations/aggilizador/aggilizador.multicalculo";
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

  it("bate 1:1 com o HAR: combustível/km/garagem/pctAjuste + campos novos (sem null/'0')", () => {
    const carro = p.cotacao.automoveis[0]!;
    // Sem overrides → defaults do HAR (flex=11, pctAjuste=100, etc.).
    expect(carro.combustivel).toBe(DEFAULTS_AGGILIZADOR.combustivel); // 11 (flex)
    expect(carro.kmAnual).toBe(DEFAULTS_AGGILIZADOR.kmAnual);
    expect(carro.garagemResidencia).toBe(DEFAULTS_AGGILIZADOR.garagem); // "1"
    // Trabalho/estudo vão "0" (confirmado no HAR de sucesso).
    expect(carro.garagemTrabalho).toBe("0");
    expect(carro.garagemEstudo).toBe("0");
    expect(carro.pctAjuste).toBe(DEFAULTS_AGGILIZADOR.pctAjuste); // 100
    // Campos do HAR antes ausentes.
    expect(carro.fipeTxt).toBe("025156-9");
    expect(carro.rastreador).toBe("0");
    expect(carro.antiFurto).toBe("0");
    expect(carro.tipoIsencao).toBe(0);
    expect(carro.blindado).toBe(false);
  });
});

describe("montarPayloadCalculo — overrides do operador (cotação manual)", () => {
  it("overrides sobrepõem os defaults; km mensal vira anual (×12)", () => {
    const entradaOverride: EntradaAggilizador = {
      ...entrada,
      combustivel: 1, // gasolina
      kmMensal: 1000,
      garagemResidencia: "2", // não
      pctAjuste: 105,
    };
    const carro = montarPayloadCalculo(segurado, calculos, veiculo, entradaOverride).cotacao.automoveis[0]!;
    expect(carro.combustivel).toBe(1);
    expect(carro.kmAnual).toBe(12_000); // 1000 mensal × 12
    expect(carro.garagemResidencia).toBe("2");
    expect(carro.garagemTrabalho).toBe("0"); // trabalho/estudo seguem "0"
    expect(carro.pctAjuste).toBe(105);
  });

  it("condutor recebe habilitação estimada (não-null) a partir da data de nascimento", () => {
    const cond = montarPayloadCalculo(segurado, calculos, veiculo, entrada).cotacao.automoveis[0]!.condutores[0]!;
    // dataNasc 1980 → habilitado ~1998 → tempoHabilitacao > 0.
    expect(cond.dataPrimHabil).toBeTruthy();
    expect(typeof cond.tempoHabilitacao).toBe("number");
    expect(cond.tempoHabilitacao!).toBeGreaterThan(0);
  });

  it("combustível decodificado do veículo tem prioridade sobre o override e o default", () => {
    const carro = montarPayloadCalculo(
      segurado,
      calculos,
      { ...veiculo, combustivel: 3 }, // veio do decode (diesel)
      { ...entrada, combustivel: 1 }, // operador pediu gasolina
    ).cotacao.automoveis[0]!;
    expect(carro.combustivel).toBe(3); // decode vence
  });
});

describe("normalizarAnosVeiculo (guard de ano)", () => {
  const ANO_BASE = 2026;

  it("anos válidos passam inalterados", () => {
    expect(normalizarAnosVeiculo("2012", "2012", ANO_BASE)).toEqual({ anoFab: "2012", anoMod: "2012" });
  });

  it("diferença > 1 ano é normalizada para ≤ 1 (regra do motor)", () => {
    // fab muito menor que mod → fab = mod − 1
    expect(normalizarAnosVeiculo("2005", "2012", ANO_BASE)).toEqual({ anoFab: "2011", anoMod: "2012" });
    // fab maior que mod → fab = mod
    expect(normalizarAnosVeiculo("2014", "2012", ANO_BASE)).toEqual({ anoFab: "2012", anoMod: "2012" });
  });

  it("um ano faltando → usa o que veio nos dois", () => {
    expect(normalizarAnosVeiculo("", "2018", ANO_BASE)).toEqual({ anoFab: "2018", anoMod: "2018" });
  });

  it("ambos ausentes/inválidos → erro claro (não envia 0)", () => {
    expect(() => normalizarAnosVeiculo("", "", ANO_BASE)).toThrow(/não decodificado/i);
    expect(() => normalizarAnosVeiculo("0", "0", ANO_BASE)).toThrow(/não decodificado/i);
    expect(() => normalizarAnosVeiculo("1800", "9999", ANO_BASE)).toThrow(/não decodificado/i);
  });
});

describe("formatarFipeTxt", () => {
  it("insere hífen antes do último dígito (HAR: 0251569 → 025156-9)", () => {
    expect(formatarFipeTxt("0251569")).toBe("025156-9");
    expect(formatarFipeTxt("025156-9")).toBe("025156-9"); // idempotente
  });
});

describe("estimarHabilitacao", () => {
  it("estima habilitação aos 18 e tempo a partir do ano-base", () => {
    const r = estimarHabilitacao("1980-11-01T00:00:00.000Z", 2026);
    expect(r.dataPrimHabil).toBe("1998-01-01T03:00:00.000Z");
    expect(r.tempoHabilitacao).toBe(28); // 2026 - 1998
  });
  it("data inválida → nulls (tolerado)", () => {
    expect(estimarHabilitacao("", 2026)).toEqual({ dataPrimHabil: null, tempoHabilitacao: null });
  });
});
