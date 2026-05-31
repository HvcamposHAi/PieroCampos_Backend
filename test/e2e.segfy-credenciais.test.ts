/**
 * E2E (nível de serviço): com SEGFY_ENABLED=true, `dispararCotacaoSegfy` resolve
 * as credenciais (banco) e as repassa para `cotarAuto` — provando que a cotação
 * passa a usar o login cadastrado na tela, não o .env. Sem rede.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  cotarAuto: vi.fn(),
  obterCredenciais: vi.fn(),
}));

vi.mock("../src/integrations/segfy/segfy.multicalculo", () => ({
  cotarAuto: h.cotarAuto,
}));
vi.mock("../src/services/segfy-credenciais.service", () => ({
  obterCredenciaisSegfy: h.obterCredenciais,
}));

import { dispararCotacaoSegfy } from "../src/services/segfy-cotacao.service";
import { InMemoryPersistence } from "../src/integrations/segfy/persistence.port";
import { _resetEnvCache } from "../src/config/env";

beforeEach(() => {
  process.env.WA_ENABLED = "false";
  process.env.BIA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "true";
  _resetEnvCache();
  h.cotarAuto.mockReset().mockResolvedValue({ quotationId: "q1", resultados: [] });
  h.obterCredenciais.mockReset().mockResolvedValue({
    email: "comercial1@x.com",
    password: "S3nh@!",
    fonte: "db",
  });
});

describe("dispararCotacaoSegfy + credenciais do banco", () => {
  it("repassa as credenciais resolvidas (banco) para cotarAuto", async () => {
    const persist = new InMemoryPersistence();
    persist.semearCliente({
      id: "cli1",
      nome: "Teste",
      cpf: "09065661930",
      email: null,
      telefone: "+5541999999999",
      segfy_id: null,
      consentimento_lgpd: true,
    });

    await dispararCotacaoSegfy(
      {
        conversaId: "conv1",
        clienteId: "cli1",
        dados: { placa: "SFI7F72", cep: "81270320", profissao: "Administrador" },
      },
      persist,
    );

    expect(h.obterCredenciais).toHaveBeenCalled();
    expect(h.cotarAuto).toHaveBeenCalledTimes(1);
    const args = h.cotarAuto.mock.calls[0]!;
    // 4º argumento = credenciais {email, password}
    expect(args[3]).toEqual({ email: "comercial1@x.com", password: "S3nh@!" });
  });

  it("sem credenciais (banco vazio e sem .env) → não chama cotarAuto e marca erro", async () => {
    h.obterCredenciais.mockResolvedValue(null);
    const persist = new InMemoryPersistence();
    persist.semearCliente({
      id: "cli1",
      nome: "Teste",
      cpf: "09065661930",
      email: null,
      telefone: "+5541999999999",
      segfy_id: null,
      consentimento_lgpd: true,
    });

    const r = await dispararCotacaoSegfy(
      { conversaId: "conv1", clienteId: "cli1", dados: { placa: "SFI7F72", cep: "81270320" } },
      persist,
    );
    expect(r).toBeNull();
    expect(h.cotarAuto).not.toHaveBeenCalled();
    // etapa 'token' marcada como erro (visível na tela de etapas)
    expect(persist.etapas.some((e) => e.etapa === "token" && e.status === "erro")).toBe(true);
  });
});
