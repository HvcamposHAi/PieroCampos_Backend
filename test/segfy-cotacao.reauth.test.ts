/**
 * Pré-check de conexão + tratamento de reauth no provider Segfy (choke point de
 * bot + manual — `segfyAutoProvider.cotar`):
 *  - Sessão caída (pré-check) → LANÇA SegfyReauthNecessariaError ANTES de criar a
 *    cotação (sem card "parou em Autenticação"); avisa o operador (1x na transição).
 *  - Pré-check OK mas o login cai no 2FA durante a corrida → rede de segurança:
 *    cotação em erro + retorno null (não quebra o bot).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SegfyReauthNecessariaError } from "../src/integrations/segfy/errors";

const marcarSessaoExpirada = vi.hoisted(() => vi.fn(async () => true));
const notificarReauthNecessaria = vi.hoisted(() => vi.fn(async () => undefined));
const conexaoUtilizavel = vi.hoisted(() =>
  vi.fn(async () => ({ conectado: true, status: "ativa" as const, valida_ate: null })),
);

vi.mock("../src/integrations/segfy/segfy.multicalculo", () => ({
  cotarAuto: vi.fn(async () => {
    throw new SegfyReauthNecessariaError();
  }),
}));
vi.mock("../src/services/segfy-credenciais.service", () => ({
  obterCredenciaisSegfy: vi.fn(async () => ({ email: "a@b.com", password: "x", fonte: "db" })),
}));
vi.mock("../src/services/segfy-sessao.service", () => ({
  restaurarSessao: vi.fn(async () => ({ tokens: { bearer: "Bearer x", automationToken: "y" }, tokensValidadeMs: 60 * 60_000 })),
  marcarSessaoExpirada,
  conexaoUtilizavel,
}));
vi.mock("../src/services/segfy-alertas.service", () => ({
  notificarReauthNecessaria,
}));
vi.mock("../src/services/segfy-seguradoras.service", () => ({
  listarSeguradorasAtivas: vi.fn(async () => []),
}));

import { segfyAutoProvider } from "../src/integrations/quote/segfy-auto.provider";
import { InMemoryPersistence } from "../src/integrations/segfy/persistence.port";
import type { QuoteContext } from "../src/integrations/quote/quote-provider.port";
import { _resetEnvCache } from "../src/config/env";

function semearAuto(mem: InMemoryPersistence) {
  mem.semearCliente({ id: "cli1", cpf: "09065661930", nome: "Humberto", email: null, telefone: "+55", segfy_id: null, consentimento_lgpd: true });
}
const CTX: QuoteContext = { conversaId: "c1", clienteId: "cli1", ramo: "auto", dados: { placa: "SFI7F72", cep: "81270320" } };

beforeEach(() => {
  process.env.WA_ENABLED = "false";
  process.env.BIA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "true";
  _resetEnvCache();
  marcarSessaoExpirada.mockClear().mockResolvedValue(true);
  notificarReauthNecessaria.mockClear();
  conexaoUtilizavel.mockClear().mockResolvedValue({ conectado: true, status: "ativa", valida_ate: null });
});

describe("segfyAutoProvider.cotar — pré-check de conexão", () => {
  it("sessão CAÍDA: lança reauth ANTES de criar a cotação (sem card) e avisa", async () => {
    conexaoUtilizavel.mockResolvedValueOnce({ conectado: false, status: "expirada", valida_ate: null });
    const mem = new InMemoryPersistence();
    semearAuto(mem);

    await expect(segfyAutoProvider.cotar(CTX, mem)).rejects.toBeInstanceOf(SegfyReauthNecessariaError);
    expect(mem.cotacoesIniciadas).toHaveLength(0); // NÃO criou cotação (sem card)
    expect(marcarSessaoExpirada).toHaveBeenCalledTimes(1);
    expect(notificarReauthNecessaria).toHaveBeenCalledTimes(1);
  });

  it("sessão caída JÁ expirada antes → não duplica o aviso", async () => {
    conexaoUtilizavel.mockResolvedValueOnce({ conectado: false, status: "expirada", valida_ate: null });
    marcarSessaoExpirada.mockResolvedValueOnce(false);
    const mem = new InMemoryPersistence();
    semearAuto(mem);
    await expect(segfyAutoProvider.cotar(CTX, mem)).rejects.toBeInstanceOf(SegfyReauthNecessariaError);
    expect(notificarReauthNecessaria).not.toHaveBeenCalled();
  });

  it("rede de segurança: pré-check OK mas login cai no 2FA → cotação em erro + null", async () => {
    // conexaoUtilizavel default = conectado:true → passa o pré-check; cotarAuto lança.
    const mem = new InMemoryPersistence();
    semearAuto(mem);
    const r = await segfyAutoProvider.cotar(CTX, mem);
    expect(r).toBeNull();
    expect(mem.cotacoesIniciadas).toHaveLength(1); // criou (observabilidade) e marcou erro
    expect(mem.cotacoesAtualizadas.some((c) => c.status === "erro")).toBe(true);
  });
});
