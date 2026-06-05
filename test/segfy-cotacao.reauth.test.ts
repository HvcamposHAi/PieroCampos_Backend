/**
 * Integração: quando o login cai no 2FA sem sessão válida, dispararCotacaoSegfy
 * NÃO quebra o bot (retorna null + cotação em erro) e MARCA a sessão como
 * expirada (para o badge do Admin pedir reautenticação).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SegfyReauthNecessariaError } from "../src/integrations/segfy/errors";

const marcarSessaoExpirada = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../src/integrations/segfy/segfy.multicalculo", () => ({
  cotarAuto: vi.fn(async () => {
    throw new SegfyReauthNecessariaError();
  }),
}));
vi.mock("../src/services/segfy-credenciais.service", () => ({
  obterCredenciaisSegfy: vi.fn(async () => ({ email: "a@b.com", password: "x", fonte: "db" })),
}));
vi.mock("../src/services/segfy-sessao.service", () => ({
  restaurarSessao: vi.fn(async () => null),
  marcarSessaoExpirada,
}));
vi.mock("../src/services/segfy-seguradoras.service", () => ({
  listarSeguradorasAtivas: vi.fn(async () => []),
}));

import { dispararCotacaoSegfy } from "../src/services/segfy-cotacao.service";
import { InMemoryPersistence } from "../src/integrations/segfy/persistence.port";
import { _resetEnvCache } from "../src/config/env";

beforeEach(() => {
  process.env.WA_ENABLED = "false";
  process.env.BIA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "true";
  _resetEnvCache();
  marcarSessaoExpirada.mockClear();
});

describe("dispararCotacaoSegfy — reauth necessária", () => {
  it("retorna null, marca cotação em erro e sinaliza sessão expirada", async () => {
    const mem = new InMemoryPersistence();
    mem.semearCliente({ id: "cli1", cpf: "09065661930", nome: "Humberto", email: null, telefone: "+55", segfy_id: null, consentimento_lgpd: true });

    const r = await dispararCotacaoSegfy(
      { conversaId: "c1", clienteId: "cli1", dados: { placa: "SFI7F72", cep: "81270320" } },
      mem,
    );

    expect(r).toBeNull();
    expect(mem.cotacoesAtualizadas.some((c) => c.status === "erro")).toBe(true);
    expect(marcarSessaoExpirada).toHaveBeenCalledTimes(1);
  });
});
