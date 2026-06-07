/**
 * E2E: rota POST /api/cotacao/manual. Sobe um Express efêmero com o cotacaoRouter
 * REAL, mockando auth (operador) e o serviço de disparo. Valida autorização,
 * validações de entrada e o contrato 202 { clienteId, cotacaoId }. Sem rede.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";

const h = vi.hoisted(() => ({
  operador: null as
    | { id: string; perfil: string; canal_padrao_id: string | null; corretora_id?: string; is_plataforma?: boolean; corretora_ativa_id?: string | null }
    | null,
  disparar: vi.fn(),
}));

// Auth: exigirOperadorAtivo controlado por h.operador; exigirAdmin sempre passa.
vi.mock("../src/middlewares/authSupabase", () => ({
  exigirAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  exigirOperadorAtivo: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (h.operador) {
      (req as unknown as { operador: unknown }).operador = h.operador;
      next();
      return;
    }
    res.status(403).json({ erro: "operador_required" });
  },
  // corretora EFETIVA: super-admin usa a ativa; demais, a sua.
  corretoraEfetiva: (op: { is_plataforma?: boolean; corretora_ativa_id?: string | null; corretora_id?: string }) =>
    op.is_plataforma ? op.corretora_ativa_id ?? null : op.corretora_id ?? null,
}));
// Serviço de disparo mockado (sem Segfy/Supabase reais).
vi.mock("../src/services/cotacao-manual.service", () => ({ dispararCotacaoManual: h.disparar }));
// Dependências pesadas do router (não usadas por /manual) — stubs para import seguro.
vi.mock("../src/services/bot.service", () => ({ confirmarEdispararCotacao: vi.fn() }));
vi.mock("../src/integrations/whatsapp/sessionManager", () => ({ sessionManager: {} }));
vi.mock("../src/integrations/whatsapp/supabase", () => ({ getSupabaseAdmin: () => ({}) }));

import { cotacaoRouter } from "../src/integrations/cotacao/routes";

let baseUrl: string;
let server: ReturnType<express.Express["listen"]>;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "usr_1", email: "op@x.com" };
    next();
  });
  app.use("/api/cotacao", cotacaoRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  h.operador = { id: "op_1", perfil: "operador", canal_padrao_id: null, corretora_id: "corr-1", is_plataforma: false };
  h.disparar.mockReset().mockResolvedValue({ clienteId: "cli-1", cotacaoId: "cot_1" });
});

const CLIENTE_OK = { nome: "Maria Teste", telefone: "+5541999990000", cpf: "090.656.619-30", email: "m@x.com" };
const DADOS_OK = { placa: "ABC1D23", cep: "80000000", profissao: "Administradora" };

async function post(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/cotacao/manual`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/cotacao/manual", () => {
  it("403 quando não há operador ativo", async () => {
    h.operador = null;
    const res = await post({ cliente: CLIENTE_OK, dados: DADOS_OK });
    expect(res.status).toBe(403);
    expect(h.disparar).not.toHaveBeenCalled();
  });

  it("202 e dispara com cliente + dados (CPF injetado em dados)", async () => {
    const res = await post({ cliente: CLIENTE_OK, dados: DADOS_OK });
    expect(res.status).toBe(202);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, clienteId: "cli-1", cotacaoId: "cot_1" });
    expect(h.disparar).toHaveBeenCalledTimes(1);
    const arg = h.disparar.mock.calls[0]![0] as {
      cliente: Record<string, unknown>;
      dados: Record<string, unknown>;
    };
    expect(arg.cliente).toMatchObject({ nome: "Maria Teste", cpf: "090.656.619-30" });
    expect(arg.dados).toMatchObject({ cpf: "090.656.619-30", placa: "ABC1D23", cep: "80000000" });
  });

  it("400 quando o CPF é inválido", async () => {
    const res = await post({ cliente: { ...CLIENTE_OK, cpf: "111.111.111-11" }, dados: DADOS_OK });
    expect(res.status).toBe(400);
    expect((await res.json()).erro).toBe("cpf_invalido");
    expect(h.disparar).not.toHaveBeenCalled();
  });

  it("400 quando faltam dados do cliente (sem nome)", async () => {
    const res = await post({ cliente: { ...CLIENTE_OK, nome: "" }, dados: DADOS_OK });
    expect(res.status).toBe(400);
    expect((await res.json()).erro).toBe("dados_cliente_incompletos");
    expect(h.disparar).not.toHaveBeenCalled();
  });
});
