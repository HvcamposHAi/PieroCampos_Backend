// Domínio registrável do remetente a partir da URL do portal (roteia o OTP por
// e-mail). Cobre ccTLD .com.br (3 rótulos) e gTLD .com (2), além de casos nulos.
import { describe, it, expect } from "vitest";
import { dominioRemetenteDeUrl } from "./apolice-emissao.service";

describe("dominioRemetenteDeUrl", () => {
  it("ccTLD .com.br → mantém 3 rótulos (subdomínios descartados)", () => {
    expect(dominioRemetenteDeUrl("https://ssoportais3.tokiomarine.com.br/openam/XUI/")).toBe("tokiomarine.com.br");
    expect(dominioRemetenteDeUrl("https://digital.akadseguros.com.br/login")).toBe("akadseguros.com.br");
    expect(dominioRemetenteDeUrl("https://corretores.justos.com.br/entrar")).toBe("justos.com.br");
  });

  it("gTLD .com → mantém 2 rótulos", () => {
    expect(dominioRemetenteDeUrl("https://auth.chubb.com/")).toBe("chubb.com");
  });

  it("nulo/invalid → null", () => {
    expect(dominioRemetenteDeUrl(null)).toBeNull();
    expect(dominioRemetenteDeUrl("não-é-url")).toBeNull();
  });
});
