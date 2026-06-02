/**
 * Teste pontual de `registrarAuditoria`:
 *   - insere o row com as colunas certas (cliente fake captura o payload);
 *   - é não-fatal: erro no insert NÃO lança;
 *   - `detalhe` com chave sensível sai redigido ([REDACTED]).
 * Sem rede: injeta um cliente fake com a forma fluente do supabase-js.
 */
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { registrarAuditoria } from "../src/integrations/auditoria/auditoria.service";

interface Captura {
  tabela?: string;
  payload?: Record<string, unknown>;
}

function clienteFake(captura: Captura, erro: unknown = null): SupabaseClient {
  const fake = {
    from(table: string) {
      return {
        async insert(payload: Record<string, unknown>) {
          captura.tabela = table;
          captura.payload = payload;
          return { error: erro };
        },
      };
    },
  };
  return fake as unknown as SupabaseClient;
}

describe("registrarAuditoria", () => {
  it("insere na tabela auditoria_eventos com as colunas mapeadas", async () => {
    const captura: Captura = {};
    await registrarAuditoria(
      {
        operadorId: "op_1",
        atorEmail: "admin@x.com",
        atorUserId: "usr_1",
        categoria: "usuarios",
        acao: "criar",
        recursoId: "alvo_9",
        metodo: "POST",
        rota: "/api/usuarios",
        statusHttp: 201,
        sucesso: true,
        ip: "203.0.113.7",
        userAgent: "vitest",
      },
      clienteFake(captura),
    );

    expect(captura.tabela).toBe("auditoria_eventos");
    expect(captura.payload).toMatchObject({
      operador_id: "op_1",
      ator_email: "admin@x.com",
      ator_user_id: "usr_1",
      categoria: "usuarios",
      acao: "criar",
      recurso_id: "alvo_9",
      metodo: "POST",
      rota: "/api/usuarios",
      status_http: 201,
      sucesso: true,
      ip: "203.0.113.7",
      user_agent: "vitest",
    });
  });

  it("é não-fatal: erro do insert não propaga", async () => {
    const captura: Captura = {};
    await expect(
      registrarAuditoria(
        { categoria: "acesso", acao: "login" },
        clienteFake(captura, { code: "42P01", message: "tabela ausente" }),
      ),
    ).resolves.toBeUndefined();
  });

  it("redige chaves sensíveis dentro de detalhe", async () => {
    const captura: Captura = {};
    await registrarAuditoria(
      {
        categoria: "acesso",
        acao: "login",
        detalhe: { motivo: "ok", senha: "supersecreta", nested: { token: "abc" } },
      },
      clienteFake(captura),
    );

    const detalhe = captura.payload?.detalhe as Record<string, unknown>;
    expect(detalhe.motivo).toBe("ok");
    expect(detalhe.senha).toBe("[REDACTED]");
    expect((detalhe.nested as Record<string, unknown>).token).toBe("[REDACTED]");
  });

  it("aplica defaults: sucesso=true e nulos onde não informado", async () => {
    const captura: Captura = {};
    await registrarAuditoria({ categoria: "acesso", acao: "logout" }, clienteFake(captura));
    expect(captura.payload).toMatchObject({
      categoria: "acesso",
      acao: "logout",
      sucesso: true,
      operador_id: null,
      detalhe: null,
    });
  });
});

// Garante que o módulo não depende de getSupabaseAdmin quando o client é injetado.
vi.mock("../src/integrations/whatsapp/supabase", () => ({
  getSupabaseAdmin: () => {
    throw new Error("não deveria ser chamado quando client é injetado");
  },
}));
