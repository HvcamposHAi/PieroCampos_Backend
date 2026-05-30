/**
 * Testes do mapeamento dados_coletados → entrada Segfy (árvores de decisão) e do
 * no-op com SEGFY_ENABLED=false (prova de não-impacto).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mapearParaCotacao, dispararCotacaoSegfy } from "../src/services/segfy-cotacao.service";
import { _resetEnvCache } from "../src/config/env";

const CLIENTE = { cpf: "090.656.619-30", nome: "Camilly" };

describe("mapearParaCotacao", () => {
  it("falta cpf/placa/cep → entrada null com lista de faltando", () => {
    const r = mapearParaCotacao({}, { cpf: null });
    expect(r.entrada).toBeNull();
    expect(r.faltando).toContain("placa do veículo");
    expect(r.faltando).toContain("cep");
  });

  it("extrai placa do texto livre e mapeia estado civil/uso (confirmados)", () => {
    const r = mapearParaCotacao(
      { dados_veiculo_fipe: "Hyundai HB20 placa SFI7F72", cep: "81270-320", estado_civil: "solteiro", utilizacao_veiculo: "particular", profissao: "Administrador", bonus: "5" },
      CLIENTE,
    );
    expect(r.entrada).not.toBeNull();
    expect(r.entrada?.cpf).toBe("09065661930");
    expect(r.entrada?.placa).toBe("SFI7F72");
    expect(r.entrada?.cep).toBe("81270320");
    expect(r.entrada?.maritalStatus).toBe("single");
    expect(r.entrada?.categoryType).toBe("particular");
    expect(r.entrada?.bonus).toBe(5);
    expect(r.entrada?.questionario?.utilization_type).toBe("personal");
  });

  it("árvore de decisão: trabalha=sim → job_garage; outro_condutor=sim → idade", () => {
    const r = mapearParaCotacao(
      {
        placa: "SFI7F72", cep: "81270320",
        trabalha: "sim", garagem_trabalho: "sim",
        estuda: "nao",
        outro_condutor: "sim", idade_condutor_secundario: "40",
      },
      CLIENTE,
    );
    expect(r.entrada?.questionario?.job_garage).toBe("yes");
    expect(r.entrada?.questionario?.study_garage).toBeUndefined(); // estuda=nao não pergunta
    expect(r.entrada?.questionario?.other_driver).toBe("exists");
    expect(r.entrada?.questionario?.secondary_driver_age).toBe("40");
  });

  it("não inventa job_garage quando não trabalha", () => {
    const r = mapearParaCotacao({ placa: "SFI7F72", cep: "81270320", trabalha: "nao" }, CLIENTE);
    expect(r.entrada?.questionario?.job_garage).toBeUndefined();
  });
});

describe("dispararCotacaoSegfy", () => {
  beforeEach(() => {
    process.env.WA_ENABLED = "false";
    process.env.BIA_ENABLED = "false";
    process.env.SEGFY_ENABLED = "false";
    _resetEnvCache();
  });

  it("retorna null sem efeitos quando SEGFY_ENABLED=false", async () => {
    const r = await dispararCotacaoSegfy({ conversaId: "c1", clienteId: "cli1", dados: { placa: "SFI7F72" } });
    expect(r).toBeNull();
  });
});
