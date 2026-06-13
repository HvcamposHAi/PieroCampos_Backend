/**
 * selecionarCalculosAuto — seleção de seguradoras para o cálculo de AUTO.
 * Cobre a CAUSA-RAIZ do "nenhuma seguradora ativa/válida": `credenciaisValidas`
 * vinha só em `configsSeg` (HAR), e o filtro lia do topo. Também o filtro por
 * ramo AUTO (seguradoraStatus) com fallback quando o status não vem.
 */
import { describe, it, expect } from "vitest";
import { selecionarCalculosAuto } from "../src/integrations/aggilizador/aggilizador.multicalculo";
import type { SeguradoraConfigItem, SeguradoraStatusItem } from "../src/integrations/aggilizador/aggilizador.types";

const CORRETORA = "024ba42d-5dce-4e36-9160-ac838882761c";

/** Item no formato REAL do HAR: credenciaisValidas só em configsSeg, idIntegracao pronto. */
function item(over: Partial<SeguradoraConfigItem> & { seguradora: number }): SeguradoraConfigItem {
  return {
    nomeSeguradora: `Seg${over.seguradora}`,
    login: "user",
    senha: "pw",
    ativo: true,
    idIntegracao: `_seguradora_${over.seguradora}_corretora_${CORRETORA}_`,
    configsSeg: { credenciaisValidas: true, ativo: true },
    ...over,
  };
}
const statusAuto = (ids: number[]): SeguradoraStatusItem[] =>
  ids.map((id) => ({ id, autoStatus: 1 }));

describe("selecionarCalculosAuto", () => {
  it("credenciaisValidas só em configsSeg → considera VÁLIDA (causa-raiz do 403→cálculo)", () => {
    const configs = [item({ seguradora: 44 })]; // sem credenciaisValidas no topo
    const { calculos, motivoZero } = selecionarCalculosAuto(configs, [], statusAuto([44]), CORRETORA, 0);
    expect(motivoZero).toBeNull();
    expect(calculos).toHaveLength(1);
    expect(calculos[0]!.seguradora).toBe(44);
  });

  it("usa o idIntegracao PRONTO da config (não remonta)", () => {
    const configs = [item({ seguradora: 12, idIntegracao: "_PRONTO_12_" })];
    const { calculos } = selecionarCalculosAuto(configs, [], statusAuto([12]), CORRETORA, 0);
    expect(calculos[0]!.idIntegracao).toBe("_PRONTO_12_");
  });

  it("remonta o idIntegracao quando a config não traz", () => {
    const configs = [item({ seguradora: 7, idIntegracao: undefined })];
    const { calculos } = selecionarCalculosAuto(configs, [], statusAuto([7]), CORRETORA, 0);
    expect(calculos[0]!.idIntegracao).toBe(`_seguradora_7_corretora_${CORRETORA}_`);
  });

  it("exclui inativa, sem credenciais e oculta (escondeLead)", () => {
    const configs = [
      item({ seguradora: 1 }), // ok
      item({ seguradora: 2, ativo: false, configsSeg: { ativo: false, credenciaisValidas: true } }), // inativa
      item({ seguradora: 3, configsSeg: { credenciaisValidas: false, ativo: true } }), // cred inválida
      item({ seguradora: 4 }), // ok, mas oculta
    ];
    const { calculos } = selecionarCalculosAuto(configs, [4], statusAuto([1, 2, 3, 4]), CORRETORA, 0);
    expect(calculos.map((c) => c.seguradora).sort()).toEqual([1]);
  });

  it("filtra por ramo AUTO: descarta quem não tem autoStatus=1", () => {
    const configs = [item({ seguradora: 10 }), item({ seguradora: 34 })]; // 34 = vida
    const { calculos } = selecionarCalculosAuto(configs, [], statusAuto([10]), CORRETORA, 0);
    expect(calculos.map((c) => c.seguradora)).toEqual([10]);
  });

  it("status vazio (falha de rede) → fallback: NÃO filtra por ramo", () => {
    const configs = [item({ seguradora: 10 }), item({ seguradora: 34 })];
    const { calculos } = selecionarCalculosAuto(configs, [], [], CORRETORA, 0);
    expect(calculos).toHaveLength(2); // não zerou por falta de status
  });

  it("motivo específico: config vazia", () => {
    const { motivoZero } = selecionarCalculosAuto([], [], [], CORRETORA, 0);
    expect(motivoZero).toMatch(/Nenhuma seguradora configurada/i);
  });

  it("motivo específico: tem config mas nenhuma com credenciais válidas", () => {
    const configs = [item({ seguradora: 1, configsSeg: { credenciaisValidas: false, ativo: true } })];
    const { motivoZero } = selecionarCalculosAuto(configs, [], statusAuto([1]), CORRETORA, 0);
    expect(motivoZero).toMatch(/credenciais válidas/i);
  });

  it("motivo específico: válidas existem, mas nenhuma habilitada p/ AUTO", () => {
    const configs = [item({ seguradora: 34 })]; // válida, mas só vida
    const { motivoZero } = selecionarCalculosAuto(configs, [], statusAuto([99]), CORRETORA, 0);
    expect(motivoZero).toMatch(/habilitada para AUTO/i);
  });

  it("propaga valorDeNovo para cada cálculo", () => {
    const configs = [item({ seguradora: 1 })];
    const { calculos } = selecionarCalculosAuto(configs, [], statusAuto([1]), CORRETORA, 1);
    expect(calculos[0]!.valorDeNovo).toBe(1);
  });
});
