// Gate do navegador da emissão: com APOLICE_RPA_ENABLED=false, emitirApolicePortal
// devolve erro `apolice_rpa_desabilitado` SEM subir o Chromium (espelha o gate do
// Segfy). Playwright é mockado para PROVAR que chromium.launch nunca é chamado.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetEnvCache } from "../../config/env";
import { ERRO_RPA_OFF, emitirApolicePortal } from "./apolice.scraper";
import type { EmitirApoliceContext } from "./apolice-provider.port";

const launchSpy = vi.fn();
vi.mock("playwright", () => ({
  chromium: { launch: (...a: unknown[]) => launchSpy(...a) },
}));

function envMinimo(): void {
  process.env.WA_ENABLED = "true";
  process.env.WA_AUTH_ENCRYPTION_KEY = "x".repeat(44);
  process.env.SUPABASE_URL = "http://localhost:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SUPABASE_ANON_KEY = "anon";
  delete process.env.APOLICE_RPA_ENABLED; // default false
  _resetEnvCache();
}

const ctx: EmitirApoliceContext = {
  corretoraId: "c1",
  seguradora: {
    id: "s1",
    corretoraId: "c1",
    nomeDisplay: "HDI Seguros",
    grupoIntegracao: "B_rpa",
    loginType: null,
    urlPortal: "https://portal.exemplo/login",
    vaultKey: null,
    emailOtp: null,
    tipoAutenticacao: null,
  },
  proposta: { id: "p1", numeroProposta: "123", clienteId: "cli1", ramo: "auto", cotacaoId: null },
  credenciais: { usuario: "u", senha: "p" },
};

describe("emitirApolicePortal — gate APOLICE_RPA_ENABLED", () => {
  beforeEach(() => {
    launchSpy.mockClear();
    envMinimo();
  });
  afterEach(() => {
    delete process.env.WA_ENABLED;
    delete process.env.WA_AUTH_ENCRYPTION_KEY;
    _resetEnvCache();
  });

  it("flag off → erro apolice_rpa_desabilitado e Chromium NÃO sobe", async () => {
    const r = await emitirApolicePortal(ctx);
    expect(r.sucesso).toBe(false);
    expect(r.erro).toBe(ERRO_RPA_OFF);
    expect(launchSpy).not.toHaveBeenCalled();
  });
});
