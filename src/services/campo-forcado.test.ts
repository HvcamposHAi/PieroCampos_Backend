// Testes da seleção de campo forçado pelo operador (fila campos_forcados).
import { describe, it, expect } from "vitest";
import { escolherCampoForcado } from "./bot.service";

describe("escolherCampoForcado", () => {
  it("retorna null quando a fila está vazia", () => {
    expect(escolherCampoForcado({}, {}, "seguro_novo")).toBeNull();
    expect(escolherCampoForcado({ campos_forcados: [] }, {}, "seguro_novo")).toBeNull();
  });

  it("retorna o primeiro campo da fila ainda pendente, com rótulo do roteiro", () => {
    const campo = escolherCampoForcado(
      { campos_forcados: ["profissao"] },
      {},
      "seguro_novo",
    );
    expect(campo?.chave).toBe("profissao");
    expect(campo?.rotulo).toBe("Profissão");
  });

  it("pula campos já preenchidos e escolhe o próximo pendente", () => {
    const campo = escolherCampoForcado(
      { campos_forcados: ["profissao", "rg"] },
      { profissao: "Engenheiro" },
      "seguro_novo",
    );
    expect(campo?.chave).toBe("rg");
  });

  it("ignora chave que não pertence ao roteiro da categoria", () => {
    const campo = escolherCampoForcado(
      { campos_forcados: ["chave_inexistente"] },
      {},
      "seguro_novo",
    );
    expect(campo).toBeNull();
  });

  it("trata string vazia como pendente (não pula)", () => {
    const campo = escolherCampoForcado(
      { campos_forcados: ["profissao"] },
      { profissao: "" },
      "seguro_novo",
    );
    expect(campo?.chave).toBe("profissao");
  });

  it("retorna null para categoria sem roteiro", () => {
    expect(escolherCampoForcado({ campos_forcados: ["segurado"] }, {}, "duvida")).toBeNull();
    expect(escolherCampoForcado({ campos_forcados: ["segurado"] }, {}, null)).toBeNull();
  });

  it("é defensivo contra campos_forcados não-array", () => {
    expect(
      escolherCampoForcado({ campos_forcados: "profissao" as unknown as string[] }, {}, "seguro_novo"),
    ).toBeNull();
  });
});
