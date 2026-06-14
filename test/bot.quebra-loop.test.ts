/**
 * Auditor de coleta ("leva o roteiro até o fim, sem loop e sem frustrar"):
 * quando a coleta não progride, FORÇA a pergunta do obrigatório que falta (em vez
 * de divagar ou desistir); só escala como ÚLTIMO RECURSO após perguntá-lo
 * diretamente vezes demais. Funções puras.
 */
import { describe, it, expect } from "vitest";
import {
  avaliarLoopColeta,
  proximoCampoColeta,
  campoForcadoQuebraLoop,
} from "../src/services/bot.service";

const SIST = "aggilizador";
// seguro_novo (aggilizador) obrigatórios na ordem: segurado, estado_civil, cep,
// numero, utilizacao_veiculo, email, cpf, placa, data_nascimento, sexo.
const E0 = { coletaTop: null as string | null, coletaReps: 0, forcar: null as string | null, forcarTent: 0 };

describe("proximoCampoColeta", () => {
  it("retorna o 1º obrigatório pendente", () => {
    expect(proximoCampoColeta("seguro_novo", {}, SIST)?.chave).toBe("segurado");
  });
});

describe("campoForcadoQuebraLoop", () => {
  it("devolve o campo que o auditor está forçando (se ainda pendente)", () => {
    const c = campoForcadoQuebraLoop({ coleta_forcar: "sexo" }, {}, "seguro_novo", SIST);
    expect(c?.chave).toBe("sexo");
  });
  it("null quando o campo forçado já foi preenchido", () => {
    expect(campoForcadoQuebraLoop({ coleta_forcar: "sexo" }, { sexo: "m" }, "seguro_novo", SIST)).toBeNull();
  });
  it("null quando não há nada forçado", () => {
    expect(campoForcadoQuebraLoop({}, {}, "seguro_novo", SIST)).toBeNull();
  });
});

describe("avaliarLoopColeta — força a pergunta, escala só em último recurso", () => {
  it("1º turno sem progresso: ainda não força (reps=1)", () => {
    const r = avaliarLoopColeta({ estado: E0, dadosPos: {}, categoria: "seguro_novo", sistema: SIST });
    expect(r.forcarCampo).toBeNull();
    expect(r.escalar).toBe(false);
    expect(r.novoEstado.coleta_reps).toBe(1);
    expect(r.novoEstado.coleta_top).toBe("segurado");
  });

  it("2º turno no mesmo topo → começa a FORÇAR a pergunta (não escala)", () => {
    const r = avaliarLoopColeta({
      estado: { coletaTop: "segurado", coletaReps: 1, forcar: null, forcarTent: 0 },
      dadosPos: {},
      categoria: "seguro_novo",
      sistema: SIST,
    });
    expect(r.forcarCampo).toBe("segurado");
    expect(r.escalar).toBe(false);
    expect(r.novoEstado.coleta_forcar).toBe("segurado");
  });

  it("forçando e cliente preenche → para de forçar e avança", () => {
    const r = avaliarLoopColeta({
      estado: { coletaTop: "segurado", coletaReps: 2, forcar: "segurado", forcarTent: 1 },
      dadosPos: { segurado: "Fulano" },
      categoria: "seguro_novo",
      sistema: SIST,
    });
    expect(r.novoEstado.coleta_forcar).toBeNull();
    expect(r.novoEstado.coleta_top).toBe("estado_civil");
    expect(r.escalar).toBe(false);
  });

  it("forçando o MESMO campo direto vezes demais → ESCALA (último recurso)", () => {
    let estado = { coletaTop: "sexo", coletaReps: 2, forcar: "sexo", forcarTent: 0 };
    const quaseTudo = {
      segurado: "x", estado_civil: "x", cep: "x", numero: "x",
      utilizacao_veiculo: "x", email: "x", cpf: "x", placa: "x", data_nascimento: "x",
    };
    let escalou = false;
    let perguntasDiretas = 0;
    for (let i = 0; i < 6 && !escalou; i++) {
      const r = avaliarLoopColeta({ estado, dadosPos: quaseTudo, categoria: "seguro_novo", sistema: SIST });
      if (r.forcarCampo === "sexo") perguntasDiretas++;
      escalou = r.escalar;
      estado = {
        coletaTop: r.novoEstado.coleta_top,
        coletaReps: r.novoEstado.coleta_reps,
        forcar: r.novoEstado.coleta_forcar,
        forcarTent: r.novoEstado.coleta_forcar_tent,
      };
    }
    expect(escalou).toBe(true);
    // perguntou o campo DIRETAMENTE várias vezes antes de desistir (não foi precoce)
    expect(perguntasDiretas).toBeGreaterThanOrEqual(3);
  });

  it("roteiro completo → não força nem escala", () => {
    const r = avaliarLoopColeta({
      estado: E0,
      dadosPos: {
        segurado: "x", estado_civil: "x", cep: "x", numero: "x",
        utilizacao_veiculo: "x", email: "x", cpf: "x", placa: "x",
        data_nascimento: "x", sexo: "x",
      },
      categoria: "seguro_novo",
      sistema: SIST,
    });
    expect(r.completo).toBe(true);
    expect(r.forcarCampo).toBeNull();
    expect(r.escalar).toBe(false);
  });
});
