/**
 * Rota POST /api/segfy/credenciais/testar — roteamento por SISTEMA da corretora.
 * Sobe um Express efêmero com o segfyRouter REAL, mockando auth e os serviços.
 * Valida: aggilizador → loginAggilizador (e grava ultimo_teste na corretora certa);
 * segfy → obterTokensSegfy; falha → ok:false com a mensagem; sem credenciais → 409.
 * Sem rede.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";

const h = vi.hoisted(() => ({
  corretoraId: "corr-sul" as string | null,
  creds: { email: "karla@x.com", password: "pw", fonte: "db" } as
    | { email: string; password: string; fonte: string }
    | null,
  sistema: "aggilizador",
  loginAgg: vi.fn(),
  obterTokens: vi.fn(),
  registrar: vi.fn(),
  restaurar: vi.fn(),
}));

vi.mock("../src/middlewares/authSupabase", () => ({
  exigirAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  exigirCorretoraSelecionada: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (h.corretoraId) {
      (req as unknown as { corretoraId: string }).corretoraId = h.corretoraId;
      next();
      return;
    }
    res.status(409).json({ erro: "corretora_nao_selecionada" });
  },
}));
vi.mock("../src/services/segfy-credenciais.service", () => ({
  obterCredenciaisSegfy: vi.fn(async () => h.creds),
  lerSistemaCotacao: vi.fn(async () => h.sistema),
  registrarTesteSegfy: (...a: unknown[]) => h.registrar(...a),
  statusCredenciaisSegfy: vi.fn(async () => ({})),
  salvarCredenciaisSegfy: vi.fn(),
}));
vi.mock("../src/integrations/aggilizador/aggilizador.auth", () => ({
  loginAggilizador: (...a: unknown[]) => h.loginAgg(...a),
}));
vi.mock("../src/integrations/segfy/segfy.multicalculo", () => ({
  obterTokensSegfy: (...a: unknown[]) => h.obterTokens(...a),
}));
vi.mock("../src/services/segfy-sessao.service", () => ({
  restaurarSessao: (...a: unknown[]) => h.restaurar(...a),
  statusSessao: vi.fn(async () => ({})),
  conexaoUtilizavel: vi.fn(),
  confirmarReauth: vi.fn(),
  gravarTokensHarvest: vi.fn(),
  importarSessao: vi.fn(),
  iniciarReauth: vi.fn(),
  invalidarSessao: vi.fn(),
  avisoProativoSessao: vi.fn(),
}));
vi.mock("../src/services/segfy-alertas.service", () => ({ notificarReauthNecessaria: vi.fn() }));
vi.mock("../src/services/segfy-reauth-orq.service", () => ({
  agenteReportar: vi.fn(),
  enviarCodigoReauth: vi.fn(),
  pegarTrabalhoReauth: vi.fn(),
  solicitarReauth: vi.fn(),
  statusReauth: vi.fn(),
}));
vi.mock("../src/services/segfy-seguradoras.service", () => ({
  atualizarSeguradora: vi.fn(),
  listarSeguradorasConfig: vi.fn(),
  sincronizarSeguradoras: vi.fn(),
}));

import { segfyRouter } from "../src/integrations/segfy/credenciais.routes";

let baseUrl: string;
let server: ReturnType<express.Express["listen"]>;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { id: "usr_1", email: "op@x.com" };
    next();
  });
  app.use("/api/segfy", segfyRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  h.corretoraId = "corr-sul";
  h.creds = { email: "karla@x.com", password: "pw", fonte: "db" };
  h.sistema = "aggilizador";
  h.loginAgg.mockReset().mockResolvedValue({});
  h.obterTokens.mockReset().mockResolvedValue({});
  h.registrar.mockReset().mockResolvedValue(undefined);
  h.restaurar.mockReset().mockResolvedValue(null);
});

async function testar(): Promise<Response> {
  return fetch(`${baseUrl}/api/segfy/credenciais/testar`, { method: "POST" });
}

describe("POST /api/segfy/credenciais/testar", () => {
  it("aggilizador + login OK → ok:true, chama loginAggilizador (não o Segfy) e grava na corretora certa", async () => {
    const res = await testar();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(h.loginAgg).toHaveBeenCalledTimes(1);
    expect(h.obterTokens).not.toHaveBeenCalled();
    // registrarTesteSegfy(ok=true, msg, corretoraId)
    const [ok, , corretoraId] = h.registrar.mock.calls[0]!;
    expect(ok).toBe(true);
    expect(corretoraId).toBe("corr-sul");
  });

  it("aggilizador + login FALHA → ok:false com a mensagem; grava ultimo_teste=false", async () => {
    h.loginAgg.mockRejectedValue(new Error("Aggilizador: falha no login — HTTP 401: credencial"));
    const res = await testar();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; mensagem?: string };
    expect(json.ok).toBe(false);
    expect(json.mensagem).toMatch(/Aggilizador/);
    expect(h.registrar.mock.calls[0]![0]).toBe(false);
  });

  it("segfy → usa obterTokensSegfy (não chama o Aggilizador)", async () => {
    h.sistema = "segfy";
    const res = await testar();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(h.obterTokens).toHaveBeenCalledTimes(1);
    expect(h.loginAgg).not.toHaveBeenCalled();
  });

  it("sem credenciais → 409 sem_credenciais (não testa nada)", async () => {
    h.creds = null;
    const res = await testar();
    expect(res.status).toBe(409);
    expect((await res.json()).erro).toBe("sem_credenciais");
    expect(h.loginAgg).not.toHaveBeenCalled();
    expect(h.obterTokens).not.toHaveBeenCalled();
  });
});
