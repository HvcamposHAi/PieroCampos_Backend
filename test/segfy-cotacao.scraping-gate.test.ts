/**
 * E2E do gating de scraping: com SEGFY_SCRAPING_ENABLED=false, a cotação HTTP
 * (caminho normal, sem browser) conclui NORMALMENTE — provando que desligar o
 * Playwright não bloqueia o fluxo de cotação. Em paralelo, o gate primário do
 * scraper (iniciarReauthSegfy) falha com "scraping_desabilitado" ANTES de subir
 * o navegador — provando o isolamento do Playwright.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ResultadoCotacaoItem } from "../src/integrations/segfy/segfy.types";

const RESULTADO: ResultadoCotacaoItem = {
  seguradora: "Mapfre",
  premio_total: 1000,
  parcelas: 10,
  valor_parcela: 100,
  coberturas_resumo: "compreensiva",
  status: "cotado",
};

// Caminho HTTP de cotação (sem browser): mockado para SUCESSO.
vi.mock("../src/integrations/segfy/segfy.multicalculo", () => ({
  cotarAuto: vi.fn(async () => ({ quotationId: "q-1", resultados: [RESULTADO] })),
}));
vi.mock("../src/services/segfy-credenciais.service", () => ({
  obterCredenciaisSegfy: vi.fn(async () => ({ email: "a@b.com", password: "x", fonte: "db" })),
}));
vi.mock("../src/services/segfy-sessao.service", () => ({
  restaurarSessao: vi.fn(async () => null),
  marcarSessaoExpirada: vi.fn(async () => undefined),
}));
vi.mock("../src/services/segfy-seguradoras.service", () => ({
  listarSeguradorasAtivas: vi.fn(async () => []),
}));

import { dispararCotacaoSegfy } from "../src/services/segfy-cotacao.service";
import { InMemoryPersistence } from "../src/integrations/segfy/persistence.port";
import { iniciarReauthSegfy } from "../src/integrations/segfy/segfy.scraper";
import { _resetEnvCache } from "../src/config/env";

beforeEach(() => {
  process.env.WA_ENABLED = "false";
  process.env.BIA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "true";
  process.env.SEGFY_SCRAPING_ENABLED = "false"; // scraping DESLIGADO
  _resetEnvCache();
});

describe("gating de scraping — não afeta a cotação HTTP", () => {
  it("cotação conclui mesmo com SEGFY_SCRAPING_ENABLED=false", async () => {
    const mem = new InMemoryPersistence();
    mem.semearCliente({
      id: "cli1",
      cpf: "09065661930",
      nome: "Humberto",
      email: null,
      telefone: "+55",
      segfy_id: null,
      consentimento_lgpd: true,
    });

    const r = await dispararCotacaoSegfy(
      { conversaId: "c1", clienteId: "cli1", dados: { placa: "SFI7F72", cep: "81270320" } },
      mem,
    );

    expect(r).not.toBeNull();
    expect(r?.maisBarata?.seguradora).toBe("Mapfre");
    expect(mem.cotacoesAtualizadas.some((c) => c.status === "concluida")).toBe(true);
  });

  it("iniciarReauthSegfy (Playwright) falha com 'scraping_desabilitado' sem subir o navegador", async () => {
    await expect(
      iniciarReauthSegfy({ email: "a@b.com", password: "x", headless: true }),
    ).rejects.toThrow("scraping_desabilitado");
  });
});
