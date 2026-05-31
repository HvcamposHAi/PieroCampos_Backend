/**
 * Testes do mapeamento dados_coletados → entrada Segfy (árvores de decisão) e do
 * no-op com SEGFY_ENABLED=false (prova de não-impacto).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mapearParaCotacao, dispararCotacaoSegfy } from "../src/services/segfy-cotacao.service";
import { InMemoryPersistence } from "../src/integrations/segfy/persistence.port";
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

  it("árvore de decisão: trabalha/estuda/condutor jovem com valores reais do form", () => {
    const r = mapearParaCotacao(
      {
        placa: "SFI7F72", cep: "81270320",
        trabalha: "sim", garagem_trabalho: "sim",
        estuda: "nao",
        condutor_jovem: "sim", sexo_condutor_jovem: "feminino", idade_condutor_secundario: "20",
      },
      CLIENTE,
    );
    expect(r.entrada?.questionario?.job_garage).toBe("yes");
    expect(r.entrada?.questionario?.study_garage).toBe("does_not_study"); // estuda=nao
    expect(r.entrada?.questionario?.other_driver).toBe("yes_female");
    expect(r.entrada?.questionario?.secondary_driver_age).toBe("age_18_to_24"); // 20 < 25
  });

  it("não trabalha → job_garage=does_not_work; sem resposta → não mexe", () => {
    const r = mapearParaCotacao({ placa: "SFI7F72", cep: "81270320", trabalha: "nao" }, CLIENTE);
    expect(r.entrada?.questionario?.job_garage).toBe("does_not_work");
    const semDados = mapearParaCotacao({ placa: "SFI7F72", cep: "81270320" }, CLIENTE);
    expect(semDados.entrada?.questionario).toBeUndefined(); // nada respondido → usa padrão
  });
});

describe("dispararCotacaoSegfy", () => {
  beforeEach(() => {
    process.env.WA_ENABLED = "false";
    process.env.BIA_ENABLED = "false";
    process.env.SEGFY_ENABLED = "false";
    _resetEnvCache();
  });

  it("SEGFY_ENABLED=false: não cota, mas DEIXA RASTRO (cotação + etapa de erro visível)", async () => {
    const mem = new InMemoryPersistence();
    const r = await dispararCotacaoSegfy(
      { conversaId: "c1", clienteId: "cli1", dados: { placa: "SFI7F72" } },
      mem,
    );
    expect(r).toBeNull();
    // Observabilidade: criou a cotação e registrou a etapa de erro legível.
    expect(mem.cotacoesIniciadas).toHaveLength(1);
    expect(mem.cotacoesAtualizadas.some((c) => c.status === "erro")).toBe(true);
    const erro = mem.etapas.find((e) => e.status === "erro");
    expect(erro?.mensagem).toMatch(/desabilitada/i);
  });

  it("dados faltando: etapa de erro ACIONÁVEL (Complemente) apontando o que falta", async () => {
    process.env.SEGFY_ENABLED = "true";
    _resetEnvCache();
    const mem = new InMemoryPersistence();
    mem.semearCliente({ id: "cli1", cpf: null, nome: "Humberto", email: null, telefone: "+55", segfy_id: null, consentimento_lgpd: true });
    const r = await dispararCotacaoSegfy(
      { conversaId: "c1", clienteId: "cli1", dados: {} }, // sem cpf/placa/cep
      mem,
    );
    expect(r).toBeNull();
    const erro = mem.etapas.find((e) => e.status === "erro");
    expect(erro?.etapa).toBe("segurado"); // cpf falta → etapa do segurado
    expect(erro?.mensagem).toMatch(/Faltam dados para cotar/i);
    expect(erro?.mensagem).toMatch(/Complemente/i);
    expect(erro?.mensagem).toMatch(/cpf/i);
  });
});
