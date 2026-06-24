import { describe, it, expect } from "vitest";
import { resolverProviderEmissao } from "../src/services/apolice-emissao.service";
import type { ApoliceProvider, SeguradoraConfigRef } from "../src/integrations/apolice/apolice-provider.port";
import type { AdapterSpec } from "../src/integrations/descoberta/descoberta.types";

const ref: SeguradoraConfigRef = {
  id: "seg-1",
  corretoraId: "corr-1",
  nomeDisplay: "Exemplo",
  grupoIntegracao: "B_rpa",
  loginType: null,
  urlPortal: "https://portal.x.com",
  urlEmissao: null,
  vaultKey: null,
  emailOtp: null,
  tipoAutenticacao: null,
};

const specValidado: AdapterSpec = {
  sistema: "exemplo",
  ramo: "auto",
  operacao: "apolice",
  objetivo: "apolice",
  seguradoraConfigId: "seg-1",
  versao: 1,
  entradaObrigatoria: [],
  passos: [],
  passosRpa: [{ tipo: "navegar", url: "https://portal.x.com" }],
};

const providerFake = (nome: string): ApoliceProvider => ({ nome, grupo: "B_rpa", emitir: async () => ({ sucesso: false, numeroApolice: null, inicioVigencia: null, fimVigencia: null, premioTotal: null, premioLiquido: null }) });

describe("resolverProviderEmissao (handoff ADI, FAIL-CLOSED)", () => {
  it("SEM adapter validado → driver legado por grupo (apolice-rpa)", async () => {
    const p = await resolverProviderEmissao(ref, "auto", "corr-1", {
      lerAdapterValidado: async () => null,
    });
    expect(p.nome).toBe("apolice-rpa"); // rpaApoliceProvider (B_rpa)
  });

  it("COM adapter validado + flag → provider do adapter", async () => {
    const p = await resolverProviderEmissao(ref, "auto", "corr-1", {
      lerAdapterValidado: async () => specValidado,
      criarProviderAdapter: (spec) => providerFake(`apolice-adapter:${spec.seguradoraConfigId}`),
    });
    expect(p.nome).toBe("apolice-adapter:seg-1");
  });

  it("erro ao carregar adapter → FAIL-CLOSED p/ legado", async () => {
    const p = await resolverProviderEmissao(ref, "auto", "corr-1", {
      lerAdapterValidado: async () => {
        throw new Error("db down");
      },
    });
    expect(p.nome).toBe("apolice-rpa");
  });

  it("deps.provider tem prioridade absoluta (teste/override)", async () => {
    const fake = providerFake("fake-injetado");
    const p = await resolverProviderEmissao(ref, "auto", "corr-1", { provider: fake });
    expect(p).toBe(fake);
  });
});
