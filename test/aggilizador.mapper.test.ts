/**
 * Mapeamento dados_coletados → entrada do Aggilizador. PURO — sem rede.
 * A crítica de obrigatórios (cpf/placa/cep) é a MESMA do Segfy (reusa
 * extrairObrigatorios), garantindo paridade do `faltando[]` entre sistemas.
 */
import { describe, it, expect } from "vitest";
import { mapearParaCotacaoAggilizador } from "../src/integrations/aggilizador/aggilizador.mapper";

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
      { cpf: "090.656.619-30", placa: "SFI7F72", cep: "81270320", data_nascimento: "03/11/1980" },
      CLIENTE,
    );
    expect(r.entrada?.estadoCivilCodigo).toBe(3);
    expect(r.entrada?.dataNascimento).toBe("1980-11-03");
    // email/nome herdam do cadastro do cliente quando não coletados.
    expect(r.entrada?.email).toBe("k@x.com");
    expect(r.entrada?.nome).toBe("Karla");
  });
});
