/**
 * Garante que o adapter Supabase mapeia os campos certos para as tabelas certas
 * (clientes / cotacoes / segfy_sync_log). Não usa rede: injeta um cliente fake
 * com a forma fluente do supabase-js.
 */
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabasePersistence } from "../src/integrations/persistence/supabase-persistence";
import type { Database } from "../src/integrations/persistence/supabase.types";

interface Handlers {
  clienteRow?: { data: unknown; error: unknown };
  insertedCotacaoId?: string;
  updateError?: unknown;
}

interface Captura {
  cotacaoInsert?: Record<string, unknown>;
  clienteUpdate?: Record<string, unknown>;
  logInsert?: Record<string, unknown>;
  filtros: Array<{ table: string; col: string; valor: unknown }>;
}

function criarClienteFake(handlers: Handlers, captura: Captura): SupabaseClient<Database> {
  const fake = {
    from(table: string) {
      const ctx = {
        _pendingUpdate: false as boolean,
        _pendingInsert: false as boolean,
        select() {
          return ctx;
        },
        insert(payload: Record<string, unknown>) {
          ctx._pendingInsert = true;
          if (table === "cotacoes") captura.cotacaoInsert = payload;
          if (table === "segfy_sync_log") captura.logInsert = payload;
          return ctx;
        },
        update(payload: Record<string, unknown>) {
          ctx._pendingUpdate = true;
          if (table === "clientes") captura.clienteUpdate = payload;
          return ctx;
        },
        eq(col: string, valor: unknown) {
          captura.filtros.push({ table, col, valor });
          return ctx;
        },
        is(col: string, valor: unknown) {
          captura.filtros.push({ table, col, valor });
          return ctx;
        },
        async maybeSingle() {
          if (table === "clientes") return handlers.clienteRow ?? { data: null, error: null };
          return { data: null, error: null };
        },
        async single() {
          if (table === "cotacoes") {
            return { data: { id: handlers.insertedCotacaoId ?? "cot_x" }, error: null };
          }
          return { data: null, error: null };
        },
        then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
          const resultado = ctx._pendingUpdate
            ? { error: handlers.updateError ?? null }
            : ctx._pendingInsert
              ? { error: null }
              : { data: null, error: null };
          return Promise.resolve(resultado).then(onF, onR);
        },
      };
      return ctx;
    },
  };
  return fake as unknown as SupabaseClient<Database>;
}

describe("SupabasePersistence", () => {
  it("buscarClientePorId mapeia colunas e filtra por id", async () => {
    const captura: Captura = { filtros: [] };
    const fake = criarClienteFake(
      {
        clienteRow: {
          data: {
            id: "cli_1",
            nome: "Demo",
            cpf: "000",
            email: null,
            telefone: "+55",
            segfy_id: null,
            consentimento_lgpd: true,
          },
          error: null,
        },
      },
      captura,
    );
    const p = new SupabasePersistence(fake);

    const cliente = await p.buscarClientePorId("cli_1");
    expect(cliente?.id).toBe("cli_1");
    expect(cliente?.consentimento_lgpd).toBe(true);
    expect(captura.filtros).toContainEqual({ table: "clientes", col: "id", valor: "cli_1" });
  });

  it("buscarClientePorId filtra soft-delete (deletado_em IS NULL) — A9/LGPD", async () => {
    const captura: Captura = { filtros: [] };
    const fake = criarClienteFake({ clienteRow: { data: null, error: null } }, captura);
    const p = new SupabasePersistence(fake);

    await p.buscarClientePorId("cli_1");
    // Garante que clientes excluídos (soft-delete) nunca têm PII enviada ao Segfy.
    expect(captura.filtros).toContainEqual({ table: "clientes", col: "deletado_em", valor: null });
  });

  it("buscarClientePorId retorna null quando não encontra", async () => {
    const captura: Captura = { filtros: [] };
    const fake = criarClienteFake({ clienteRow: { data: null, error: null } }, captura);
    const p = new SupabasePersistence(fake);
    expect(await p.buscarClientePorId("nao_existe")).toBeNull();
  });

  it("vincularSegfyIdAoCliente envia segfy_id no UPDATE e filtra por id", async () => {
    const captura: Captura = { filtros: [] };
    const fake = criarClienteFake({}, captura);
    const p = new SupabasePersistence(fake);

    await p.vincularSegfyIdAoCliente("cli_1", "seg_42");
    expect(captura.clienteUpdate).toEqual({ segfy_id: "seg_42" });
    expect(captura.filtros).toContainEqual({ table: "clientes", col: "id", valor: "cli_1" });
  });

  it("salvarCotacao envia os campos certos e devolve o id gerado", async () => {
    const captura: Captura = { filtros: [] };
    const fake = criarClienteFake({ insertedCotacaoId: "cot_99" }, captura);
    const p = new SupabasePersistence(fake);

    const r = await p.salvarCotacao({
      conversaId: "conv_1",
      clienteId: "cli_1",
      ramo: "auto",
      dadosEntrada: { nome: "Demo" },
      resultados: [
        { seguradora: "X", premio_total: 100, parcelas: 1, valor_parcela: 100, coberturas_resumo: "c", status: "cotado" },
      ],
      segfyCotacaoId: "cotseg_1",
      validadeAte: "2026-06-03T00:00:00Z",
    });

    expect(r.cotacaoId).toBe("cot_99");
    expect(captura.cotacaoInsert).toMatchObject({
      cliente_id: "cli_1",
      conversa_id: "conv_1",
      ramo: "auto",
      segfy_cotacao_id: "cotseg_1",
      validade_ate: "2026-06-03T00:00:00Z",
      status: "concluida",
    });
    // o adapter NÃO grava segurado_id em segfy_cotacao_id (bug do MD §9):
    expect((captura.cotacaoInsert as { segfy_cotacao_id: string }).segfy_cotacao_id).toBe("cotseg_1");
  });

  it("registrarLog insere na segfy_sync_log e não relança erro do log", async () => {
    const captura: Captura = { filtros: [] };
    const fake = criarClienteFake({}, captura);
    const p = new SupabasePersistence(fake);

    await p.registrarLog({
      operacao: "cotacao",
      via: "api",
      refId: "cotseg_1",
      sucesso: true,
      detalhe: { total: 3 },
    });
    expect(captura.logInsert).toMatchObject({
      operacao: "cotacao",
      via: "api",
      ref_id: "cotseg_1",
      sucesso: true,
      detalhe: { total: 3 },
    });
  });

  it("construtor sem cliente exige SUPABASE_URL/SERVICE_ROLE", () => {
    // sem env preenchida, deve lançar
    const original = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      expect(() => new SupabasePersistence()).toThrow(/SUPABASE_URL/);
    } finally {
      if (original.url !== undefined) process.env.SUPABASE_URL = original.url;
      if (original.key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = original.key;
    }
  });
});
