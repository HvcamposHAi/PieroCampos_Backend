import { describe, it, expect } from "vitest";
import { validarEstrutura } from "./estrutura.validator";

describe("validarEstrutura (portão pré-build)", () => {
  it("apólice: suporta quando há login + localizar proposta + emitir", () => {
    const r = validarEstrutura("apolice", {
      markup: '<input type="password" name="senha"> <a>Localizar proposta</a> <button>Emitir apólice</button>',
    });
    expect(r.veredito).toBe("suporta");
    expect(r.lacunas).toHaveLength(0);
  });

  it("apólice: SEM login é eliminatório → nao_suporta", () => {
    const r = validarEstrutura("apolice", { markup: "<button>Emitir apólice</button> <a>buscar proposta</a>" });
    expect(r.veredito).toBe("nao_suporta");
    expect(r.lacunas).toContain("login (usuário+senha)");
  });

  it("apólice: com login mas SEM emitir → parcial", () => {
    const r = validarEstrutura("apolice", { loginOk: true, markup: "<a>buscar proposta</a>" });
    expect(r.veredito).toBe("parcial");
    expect(r.lacunas).toContain("ação de emitir apólice");
  });

  it("cotação: detecta ação de calcular por endpoint", () => {
    const r = validarEstrutura("cotacao", { loginOk: true, endpoints: ["/calculo/calcularV2"] });
    expect(r.veredito).toBe("suporta");
  });
});
