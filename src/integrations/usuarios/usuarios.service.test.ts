// Testes do serviço de usuários do portal. Mocka o cliente Supabase admin
// (getSupabaseAdmin) — cobre os 3 cenários de definirSenha, a criação (com
// reconcile por e-mail) e o mapeamento de erros de domínio.
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted: o stub do Supabase precisa existir antes do vi.mock (hoisted).
const h = vi.hoisted(() => {
  const fromResults: Array<{ data: unknown; error: unknown }> = [];
  const rec = {
    upsert: [] as unknown[][],
    update: [] as unknown[][],
    eq: [] as unknown[][],
    select: [] as unknown[][],
  };
  const authAdmin = {
    createUser: vi.fn(),
    updateUserById: vi.fn(),
    listUsers: vi.fn(),
  };
  // Builder encadeável e "awaitable": todo método volta o próprio builder e o
  // builder resolve para o `result` configurado (cobre .single/.maybeSingle/.eq/.order).
  function builder(result: { data: unknown; error: unknown }) {
    const b: Record<string, unknown> = { then: (r: (v: unknown) => void) => r(result) };
    b.select = vi.fn((...a: unknown[]) => (rec.select.push(a), b));
    b.upsert = vi.fn((...a: unknown[]) => (rec.upsert.push(a), b));
    b.update = vi.fn((...a: unknown[]) => (rec.update.push(a), b));
    b.eq = vi.fn((...a: unknown[]) => (rec.eq.push(a), b));
    b.order = vi.fn(() => b);
    b.maybeSingle = vi.fn(() => b);
    b.single = vi.fn(() => b);
    return b;
  }
  const sb = {
    from: vi.fn(() => builder(fromResults.length ? fromResults.shift()! : { data: null, error: null })),
    auth: { admin: authAdmin },
  };
  return { fromResults, rec, authAdmin, sb };
});

vi.mock("../whatsapp/supabase", () => ({ getSupabaseAdmin: () => h.sb }));

import { ErroUsuario, atualizarUsuario, criarUsuario, definirSenha } from "./usuarios.service";

beforeEach(() => {
  h.fromResults.length = 0;
  h.rec.upsert.length = 0;
  h.rec.update.length = 0;
  h.rec.eq.length = 0;
  h.rec.select.length = 0;
  h.authAdmin.createUser.mockReset();
  h.authAdmin.updateUserById.mockReset();
  h.authAdmin.listUsers.mockReset();
  h.sb.from.mockClear();
});

describe("criarUsuario", () => {
  it("cria o auth user (email_confirm) e reconcilia operadores por e-mail", async () => {
    h.authAdmin.createUser.mockResolvedValue({ data: { user: { id: "uid-1" } }, error: null });
    h.fromResults.push({
      data: {
        id: "op-1",
        nome: "Maria",
        email: "maria@x.com",
        perfil: "operador",
        ativo: true,
        supabase_user_id: "uid-1",
        criado_em: "2026-06-01T00:00:00Z",
      },
      error: null,
    });

    const u = await criarUsuario({
      nome: "  Maria ",
      email: "Maria@X.com",
      perfil: "operador",
      ativo: true,
      senha: "senha1234",
    });

    expect(h.authAdmin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "maria@x.com",
        password: "senha1234",
        email_confirm: true,
        user_metadata: { nome: "Maria" },
      }),
    );
    expect(h.rec.upsert[0][1]).toEqual({ onConflict: "email" });
    expect(h.rec.upsert[0][0]).toMatchObject({
      email: "maria@x.com",
      supabase_user_id: "uid-1",
      perfil: "operador",
      ativo: true,
    });
    expect(u.supabase_user_id).toBe("uid-1");
  });

  it("converte e-mail duplicado em ErroUsuario('email_exists')", async () => {
    h.authAdmin.createUser.mockResolvedValue({
      data: { user: null },
      error: { message: "A user with this email address has already been registered", code: "email_exists" },
    });
    await expect(
      criarUsuario({ nome: "Maria", email: "m@x.com", perfil: "operador", ativo: true, senha: "senha1234" }),
    ).rejects.toMatchObject({ codigo: "email_exists" });
    expect(h.rec.upsert.length).toBe(0);
  });
});

describe("definirSenha", () => {
  it("cenário 1: operador já vinculado → updateUserById, sem listUsers/createUser", async () => {
    h.fromResults.push({
      data: { id: "op-1", nome: "Maria", email: "m@x.com", supabase_user_id: "uid-1" },
      error: null,
    });
    h.authAdmin.updateUserById.mockResolvedValue({ data: {}, error: null });

    const r = await definirSenha({ operadorId: "op-1", senha: "novaSenha1" });

    expect(h.authAdmin.updateUserById).toHaveBeenCalledWith("uid-1", { password: "novaSenha1" });
    expect(h.authAdmin.listUsers).not.toHaveBeenCalled();
    expect(h.authAdmin.createUser).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, criouLogin: false });
  });

  it("cenário 2: sem vínculo, auth user existe → vincula + troca senha", async () => {
    h.fromResults.push({
      data: { id: "op-1", nome: "Maria", email: "m@x.com", supabase_user_id: null },
      error: null,
    });
    h.fromResults.push({ data: null, error: null }); // update do vínculo
    h.authAdmin.listUsers.mockResolvedValue({ data: { users: [{ id: "uid-X", email: "m@x.com" }] }, error: null });
    h.authAdmin.updateUserById.mockResolvedValue({ data: {}, error: null });

    const r = await definirSenha({ operadorId: "op-1", senha: "novaSenha1" });

    expect(h.authAdmin.updateUserById).toHaveBeenCalledWith("uid-X", { password: "novaSenha1" });
    expect(h.authAdmin.createUser).not.toHaveBeenCalled();
    expect(h.rec.update[0][0]).toMatchObject({ supabase_user_id: "uid-X" });
    expect(r).toEqual({ ok: true, criouLogin: false });
  });

  it("cenário 3: sem vínculo e sem auth user → cria login + vincula (criouLogin=true)", async () => {
    h.fromResults.push({
      data: { id: "op-1", nome: "Maria", email: "m@x.com", supabase_user_id: null },
      error: null,
    });
    h.fromResults.push({ data: null, error: null }); // update do vínculo
    h.authAdmin.listUsers.mockResolvedValue({ data: { users: [] }, error: null });
    h.authAdmin.createUser.mockResolvedValue({ data: { user: { id: "uid-NEW" } }, error: null });

    const r = await definirSenha({ operadorId: "op-1", senha: "novaSenha1" });

    expect(h.authAdmin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: "m@x.com", password: "novaSenha1", email_confirm: true }),
    );
    expect(h.rec.update[0][0]).toMatchObject({ supabase_user_id: "uid-NEW" });
    expect(r).toEqual({ ok: true, criouLogin: true });
  });

  it("operador inexistente → ErroUsuario('nao_encontrado')", async () => {
    h.fromResults.push({ data: null, error: null });
    await expect(definirSenha({ operadorId: "nope", senha: "novaSenha1" })).rejects.toBeInstanceOf(ErroUsuario);
  });
});

describe("atualizarUsuario", () => {
  it("atualiza nome/perfil/ativo e devolve a linha", async () => {
    h.fromResults.push({
      data: {
        id: "op-1",
        nome: "Maria Souza",
        email: "m@x.com",
        perfil: "supervisor",
        ativo: true,
        supabase_user_id: "uid-1",
        criado_em: "2026-06-01T00:00:00Z",
      },
      error: null,
    });
    const u = await atualizarUsuario({ operadorId: "op-1", perfil: "supervisor", nome: "Maria Souza" });
    expect(h.rec.update[0][0]).toMatchObject({ perfil: "supervisor", nome: "Maria Souza" });
    expect(u.perfil).toBe("supervisor");
  });

  it("id inexistente → ErroUsuario('nao_encontrado')", async () => {
    h.fromResults.push({ data: null, error: null });
    await expect(atualizarUsuario({ operadorId: "nope", ativo: false })).rejects.toBeInstanceOf(ErroUsuario);
  });
});
