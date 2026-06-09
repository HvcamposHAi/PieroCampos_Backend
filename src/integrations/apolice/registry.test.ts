// Registry de providers de EMISSÃO por grupo_integracao: A_api→api, B_rpa→rpa,
// C_otp→rpa+otp; grupo desconhecido cai no fallback seguro (RPA). Puro, sem env.
import { describe, it, expect } from "vitest";
import { getApoliceProvider } from "./registry";
import type { GrupoIntegracao } from "./apolice-provider.port";

describe("getApoliceProvider (registry de emissão)", () => {
  it("A_api → provider de API", () => {
    const p = getApoliceProvider({ grupoIntegracao: "A_api" });
    expect(p.grupo).toBe("A_api");
    expect(p.nome).toBe("apolice-api");
  });

  it("B_rpa → provider de RPA (Playwright)", () => {
    const p = getApoliceProvider({ grupoIntegracao: "B_rpa" });
    expect(p.grupo).toBe("B_rpa");
    expect(p.nome).toBe("apolice-rpa");
  });

  it("C_otp → provider de RPA + OTP", () => {
    const p = getApoliceProvider({ grupoIntegracao: "C_otp" });
    expect(p.grupo).toBe("C_otp");
    expect(p.nome).toBe("apolice-rpa-otp");
  });

  it("grupo desconhecido → fallback seguro = RPA", () => {
    const p = getApoliceProvider({ grupoIntegracao: "X_qualquer" as GrupoIntegracao });
    expect(p.nome).toBe("apolice-rpa");
  });
});
