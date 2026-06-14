/**
 * Quebra-loop da coleta ("pergunta → registra → avança, JAMAIS loop"):
 * avaliarLoopColeta adia um obrigatório que fica no topo por 2 turnos sem
 * preencher; quando TODOS os pendentes estão adiados → travado (escala humano).
 * proximoCampoColeta pula os adiados. Funções puras.
 */
import { describe, it, expect } from "vitest";
import { avaliarLoopColeta, proximoCampoColeta } from "../src/services/bot.service";

const SIST = "aggilizador";
// seguro_novo (aggilizador) obrigatórios na ordem: segurado, estado_civil, cep,
// numero, utilizacao_veiculo, email, cpf, placa, data_nascimento, sexo.

describe("proximoCampoColeta — pula adiados", () => {
  it("sem adiados → 1º pendente", () => {
    const c = proximoCampoColeta("seguro_novo", {}, SIST, []);
    expect(c?.chave).toBe("segurado");
  });
  it("com adiado → pula para o próximo", () => {
    const c = proximoCampoColeta("seguro_novo", {}, SIST, ["segurado"]);
    expect(c?.chave).toBe("estado_civil");
  });
});

describe("avaliarLoopColeta — força avanço e escala", () => {
  it("1º turno: registra o topo, reps=1, nada adiado", () => {
    const r = avaliarLoopColeta({
      estado: { coletaTop: null, coletaReps: 0, adiados: [] },
      dadosPos: {},
      categoria: "seguro_novo",
      sistema: SIST,
    });
    expect(r.top).toBe("segurado");
    expect(r.reps).toBe(1);
    expect(r.adiados).toEqual([]);
    expect(r.travado).toBe(false);
  });

  it("mesmo campo no topo por 2 turnos sem preencher → ADIA e avança", () => {
    const r = avaliarLoopColeta({
      estado: { coletaTop: "segurado", coletaReps: 1, adiados: [] },
      dadosPos: {},
      categoria: "seguro_novo",
      sistema: SIST,
    });
    expect(r.adiados).toContain("segurado");
    expect(r.top).toBe("estado_civil"); // avançou
    expect(r.travado).toBe(false);
  });

  it("campo preenchido → zera contador e sai dos adiados", () => {
    const r = avaliarLoopColeta({
      estado: { coletaTop: "segurado", coletaReps: 1, adiados: ["segurado"] },
      dadosPos: { segurado: "Fulano" },
      categoria: "seguro_novo",
      sistema: SIST,
    });
    expect(r.adiados).not.toContain("segurado");
    expect(r.top).toBe("estado_civil");
  });

  it("último obrigatório trava (2º turno) e não há outro → TRAVADO (escala)", () => {
    const quaseTudo = {
      segurado: "x", estado_civil: "x", cep: "x", numero: "x",
      utilizacao_veiculo: "x", email: "x", cpf: "x", placa: "x", data_nascimento: "x",
    };
    const r = avaliarLoopColeta({
      estado: { coletaTop: "sexo", coletaReps: 1, adiados: [] },
      dadosPos: quaseTudo, // só falta sexo
      categoria: "seguro_novo",
      sistema: SIST,
    });
    expect(r.adiados).toContain("sexo");
    expect(r.top).toBeNull();
    expect(r.travado).toBe(true);
  });

  it("roteiro completo → não trava, completo=true", () => {
    const tudo = {
      segurado: "x", estado_civil: "x", cep: "x", numero: "x",
      utilizacao_veiculo: "x", email: "x", cpf: "x", placa: "x",
      data_nascimento: "x", sexo: "x",
    };
    const r = avaliarLoopColeta({
      estado: { coletaTop: "sexo", coletaReps: 1, adiados: [] },
      dadosPos: tudo,
      categoria: "seguro_novo",
      sistema: SIST,
    });
    expect(r.completo).toBe(true);
    expect(r.travado).toBe(false);
  });
});
