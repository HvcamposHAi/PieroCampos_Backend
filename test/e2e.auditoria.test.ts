/**
 * E2E da trilha de auditoria (sem rede externa): sobe um app Express com o
 * middleware `auditarMutacoes` e os routers de acesso, e bate com fetch num
 * servidor efêmero. `registrarAuditoria` e `carregarOperadorAtivo` são mockados
 * para capturar os eventos sem tocar no Supabase.
 *
 * Cobre:
 *   1. POST /api/auditoria/acesso {login}  → evento acesso/login (ator do JWT).
 *   2. POST /api/usuarios (201) atravessa o middleware → evento usuarios/criar.
 *   3. POST /api/auditoria/acesso-falho     → evento acesso/login_falho (sem ator).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";

const h = vi.hoisted(() => ({
  registrar: vi.fn(async () => {}),
  carregarOperador: vi.fn(async () => ({ id: "op_1", perfil: "admin" })),
}));

vi.mock("../src/integrations/auditoria/auditoria.service", () => ({
  registrarAuditoria: h.registrar,
}));
vi.mock("../src/middlewares/authSupabase", () => ({
  carregarOperadorAtivo: h.carregarOperador,
}));

import { auditarMutacoes } from "../src/middlewares/auditoria";
import {
  auditoriaRouter,
  auditoriaPublicoRouter,
  _resetRateLimitAuditoria,
} from "../src/integrations/auditoria/auditoria.routes";

let baseUrl: string;
let server: ReturnType<express.Express["listen"]>;

beforeAll(async () => {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());

  // Auth fake: simula o que o authSupabase faria após validar o JWT.
  app.use((req, _res, next) => {
    req.user = { id: "usr_1", email: "admin@x.com" };
    next();
  });

  // Pública (no app real fica antes do gate de auth).
  app.use("/api/auditoria/acesso-falho", auditoriaPublicoRouter);
  // Router autenticado de acesso (login/logout).
  app.use("/api/auditoria", auditoriaRouter);
  // Rota de negócio fictícia coberta pelo middleware de mutações.
  app.use("/api/usuarios", auditarMutacoes("usuarios"), (_req, res) => {
    res.status(201).json({ ok: true });
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  h.registrar.mockClear();
  h.carregarOperador.mockClear();
  _resetRateLimitAuditoria();
});

/** Espera até `cond()` ser verdade (o registro é fire-and-forget pós-resposta). */
async function aguardar(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const fim = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > fim) throw new Error("timeout aguardando registrarAuditoria");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function ultimoEvento(): Record<string, unknown> {
  const calls = h.registrar.mock.calls;
  return calls[calls.length - 1]![0] as Record<string, unknown>;
}

describe("E2E auditoria", () => {
  it("POST /api/auditoria/acesso {login} registra acesso/login com o ator do JWT", async () => {
    const res = await fetch(`${baseUrl}/api/auditoria/acesso`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tipo: "login" }),
    });
    expect(res.status).toBe(200);
    await aguardar(() => h.registrar.mock.calls.length >= 1);
    expect(ultimoEvento()).toMatchObject({
      categoria: "acesso",
      acao: "login",
      atorEmail: "admin@x.com",
      atorUserId: "usr_1",
      operadorId: "op_1",
      sucesso: true,
    });
  });

  it("POST /api/usuarios (201) é auditado como usuarios/criar pelo middleware", async () => {
    const res = await fetch(`${baseUrl}/api/usuarios`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: "X" }),
    });
    expect(res.status).toBe(201);
    await aguardar(() => h.registrar.mock.calls.length >= 1);
    expect(ultimoEvento()).toMatchObject({
      categoria: "usuarios",
      acao: "criar",
      metodo: "POST",
      statusHttp: 201,
      sucesso: true,
      atorEmail: "admin@x.com",
      operadorId: "op_1",
    });
  });

  it("GET não é auditado pelo middleware", async () => {
    // Monta uma rota GET sob o middleware: não deve gerar evento.
    const res = await fetch(`${baseUrl}/api/usuarios`, { method: "GET" });
    // A rota fictícia só trata o handler (qualquer método) → responde 201 mesmo no GET,
    // mas o middleware ignora GET, então nenhum registrarAuditoria deve ocorrer.
    expect([200, 201, 404]).toContain(res.status);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.registrar).not.toHaveBeenCalled();
  });

  it("POST /api/auditoria/acesso-falho registra login_falho sem ator autenticado", async () => {
    const res = await fetch(`${baseUrl}/api/auditoria/acesso-falho`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "intruso@x.com", motivo: "Invalid login credentials" }),
    });
    expect(res.status).toBe(200);
    await aguardar(() => h.registrar.mock.calls.length >= 1);
    expect(ultimoEvento()).toMatchObject({
      categoria: "acesso",
      acao: "login_falho",
      sucesso: false,
      operadorId: null,
      atorUserId: null,
      atorEmail: "intruso@x.com",
    });
  });

  it("acesso-falho aplica rate-limit por IP (HTTP 429 após o limite)", async () => {
    let viu429 = false;
    for (let i = 0; i < 15; i++) {
      const res = await fetch(`${baseUrl}/api/auditoria/acesso-falho`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "intruso@x.com" }),
      });
      if (res.status === 429) {
        viu429 = true;
        break;
      }
    }
    expect(viu429).toBe(true);
  });
});
