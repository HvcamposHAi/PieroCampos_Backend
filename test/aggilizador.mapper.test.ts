/**
 * Mapeamento dados_coletados → entrada do Aggilizador. PURO — sem rede.
 * A crítica de obrigatórios (cpf/placa/cep) é a MESMA do Segfy (reusa
 * extrairObrigatorios), garantindo paridade do `faltando[]` entre sistemas.
 */
import { describe, it, expect } from "vitest";
import { mapearParaCotacaoAggilizador, removerDdiBr } from "../src/integrations/aggilizador/aggilizador.mapper";

describe("removerDdiBr", () => {
  it("remove o 55 de E.164 (com e sem +)", () => {
    expect(removerDdiBr("+5541996247863")).toBe("41996247863");
    expect(removerDdiBr("5541996247863")).toBe("41996247863");
    expect(removerDdiBr("55 (41) 99624-7863")).toBe("41996247863");
  });
  it("preserva número já sem DDI (DDD+nº)", () => {
    expect(removerDdiBr("41996247863")).toBe("41996247863"); // 11 díg
    expect(removerDdiBr("4133334444")).toBe("4133334444"); // 10 díg (fixo)
  });
  it("vazio/indefinido → undefined", () => {
    expect(removerDdiBr("")).toBeUndefined();
    expect(removerDdiBr(null)).toBeUndefined();
  });
});

const CLIENTE = { cpf: null, nome: "Karla", email: "k@x.com", telefone: "+5541999990000" };

describe("mapearParaCotacaoAggilizador", () => {
  it("falta cpf/placa/cep → entrada null com faltando", () => {
    const r = mapearParaCotacaoAggilizador({}, CLIENTE);
    expect(r.entrada).toBeNull();
    expect(r.faltando).toContain("cpf");
    expect(r.faltando).toContain("placa do veículo");
    expect(r.faltando).toContain("cep");
  });

  it("CPF inválido → crítica 'cpf (inválido)'", () => {
    const r = mapearParaCotacaoAggilizador(
      { cpf: "000.000.000-00", placa: "SFI7F72", cep: "81270320" },
      CLIENTE,
    );
    expect(r.entrada).toBeNull();
    expect(r.faltando).toContain("cpf (inválido)");
  });

  it("dados completos → entrada com enums normalizados", () => {
    const r = mapearParaCotacaoAggilizador(
      {
        cpf: "090.656.619-30",
        placa: "SFI7F72",
        cep: "81270-320",
        nome: "Camilly",
        sexo: "feminino",
        data_nascimento: "1980-11-03",
        estado_civil: "casado",
        email: "c@x.com",
        zero_km: "nao",
      },
      CLIENTE,
    );
    expect(r.entrada).not.toBeNull();
    expect(r.entrada?.cpf).toBe("09065661930");
    expect(r.entrada?.placa).toBe("SFI7F72");
    expect(r.entrada?.cep).toBe("81270320");
    expect(r.entrada?.sexo).toBe("F");
    expect(r.entrada?.dataNascimento).toBe("1980-11-03");
    expect(r.entrada?.estadoCivilCodigo).toBe(2); // casado
    expect(r.entrada?.email).toBe("c@x.com");
    expect(r.entrada?.zeroKm).toBe(false);
  });

  it("estado civil ausente/desconhecido → default 3 (outros); data dd/mm/aaaa aceita", () => {
    const r = mapearParaCotacaoAggilizador(
      { cpf: "090.656.619-30", placa: "SFI7F72", cep: "81270320", data_nascimento: "03/11/1980", sexo: "masculino" },
      CLIENTE,
    );
    expect(r.entrada?.estadoCivilCodigo).toBe(3);
    expect(r.entrada?.dataNascimento).toBe("1980-11-03");
    // email/nome herdam do cadastro do cliente quando não coletados.
    expect(r.entrada?.email).toBe("k@x.com");
    expect(r.entrada?.nome).toBe("Karla");
  });

  it("Aggilizador EXIGE data de nascimento + sexo → faltando específico (msg clara)", () => {
    // cpf/placa/cep OK, mas SEM nasc/sexo (o Aggilizador não os busca em API).
    const r = mapearParaCotacaoAggilizador(
      { cpf: "090.656.619-30", placa: "SFI7F72", cep: "81270320" },
      CLIENTE,
    );
    expect(r.entrada).toBeNull();
    expect(r.faltando).toContain("data de nascimento");
    expect(r.faltando).toContain("sexo");
  });

  it("só sexo faltando → faltando = ['sexo'] (cpf/placa/cep/nasc OK)", () => {
    const r = mapearParaCotacaoAggilizador(
      { cpf: "090.656.619-30", placa: "SFI7F72", cep: "81270320", data_nascimento: "1980-11-03" },
      CLIENTE,
    );
    expect(r.entrada).toBeNull();
    expect(r.faltando).toEqual(["sexo"]);
  });

  // ── Overrides OPCIONAIS do questionário (cotação manual) ──────────────────────
  const BASE_OK = {
    cpf: "090.656.619-30",
    placa: "SFI7F72",
    cep: "81270320",
    data_nascimento: "1980-11-03",
    sexo: "F",
  } as const;

  it("sem overrides → campos do questionário ficam undefined (usa defaults no payload)", () => {
    const r = mapearParaCotacaoAggilizador({ ...BASE_OK }, CLIENTE);
    expect(r.entrada).not.toBeNull();
    expect(r.entrada?.combustivel).toBeUndefined();
    expect(r.entrada?.kmMensal).toBeUndefined();
    expect(r.entrada?.garagemResidencia).toBeUndefined();
    expect(r.entrada?.pctAjuste).toBeUndefined();
    expect(r.entrada?.comissaoPercentual).toBeUndefined();
  });

  it("overrides do operador são lidos e normalizados (flex=11; comissão lida)", () => {
    const r = mapearParaCotacaoAggilizador(
      {
        ...BASE_OK,
        combustivel: "flex",
        km_mes: "1500",
        garagem: "sim",
        percentual_fipe: "100",
        comissao_percentual: "3",
      },
      CLIENTE,
    );
    expect(r.entrada?.combustivel).toBe(11); // flex (HAR)
    expect(r.entrada?.kmMensal).toBe(1500);
    expect(r.entrada?.garagemResidencia).toBe("1"); // sim
    expect(r.entrada?.pctAjuste).toBe(100);
    expect(r.entrada?.comissaoPercentual).toBe(3);
  });

  it("override inválido (fora do domínio) → undefined (cai no default, não quebra)", () => {
    const r = mapearParaCotacaoAggilizador(
      { ...BASE_OK, combustivel: "foguete", km_mes: "-5", garagem: "talvez", percentual_fipe: "999", comissao_percentual: "200" },
      CLIENTE,
    );
    expect(r.entrada?.combustivel).toBeUndefined();
    expect(r.entrada?.kmMensal).toBeUndefined();
    expect(r.entrada?.garagemResidencia).toBeUndefined();
    expect(r.entrada?.pctAjuste).toBeUndefined();
    expect(r.entrada?.comissaoPercentual).toBeUndefined();
  });

  it("combustível numérico e garagem 'não' também são aceitos", () => {
    const r = mapearParaCotacaoAggilizador(
      { ...BASE_OK, combustivel: 1, garagem: "não", quilometragem_mensal: 2000 },
      CLIENTE,
    );
    expect(r.entrada?.combustivel).toBe(1);
    expect(r.entrada?.garagemResidencia).toBe("2"); // não
    expect(r.entrada?.kmMensal).toBe(2000);
  });

  it("telefone vai SEM DDI (Aggilizador usa DDD+número)", () => {
    const r = mapearParaCotacaoAggilizador(
      { ...BASE_OK, telefone: "+5541996247863" },
      CLIENTE,
    );
    expect(r.entrada?.telefone).toBe("41996247863"); // removeu o 55
  });

  it("telefone herdado do cliente (E.164) também perde o DDI", () => {
    // CLIENTE.telefone = "+5541999990000"
    const r = mapearParaCotacaoAggilizador({ ...BASE_OK }, CLIENTE);
    expect(r.entrada?.telefone).toBe("41999990000");
  });
});
