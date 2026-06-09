/**
 * Toggle global do Aprendizado contínuo (controle do usuário, no banco).
 * Cobre o gate que substituiu a env APRENDIZADO_ENABLED:
 *   - lerAprendizadoAtivo: fail-closed, cache TTL, linha ausente;
 *   - definirAprendizadoAtivo: upsert na singleton + reflexo imediato no cache;
 *   - obterAdmin().habilitado: espelha o toggle do banco.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const fake = vi.hoisted(() => ({
  config: { ativo: false } as { ativo: boolean } | null,
  configError: null as { message: string } | null,
  playbook: [] as Array<Record<string, unknown>>,
  jobs: [] as Array<Record<string, unknown>>,
  upserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  selectCount: {} as Record<string, number>,
}));

vi.mock("../src/integrations/whatsapp/supabase", () => ({
  getSupabaseAdmin: () => ({
    from(table: string) {
      const dataFor = () =>
        table === "aprendizado_config"
          ? { rows: fake.config ? [fake.config] : [], error: fake.configError }
          : table === "aprendizado_playbook"
            ? { rows: fake.playbook, error: null }
            : table === "aprendizado_job"
              ? { rows: fake.jobs, error: null }
              : { rows: [], error: null };
      const bump = () => {
        fake.selectCount[table] = (fake.selectCount[table] ?? 0) + 1;
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx: any = {
        select: () => ctx,
        eq: () => ctx,
        neq: () => ctx,
        is: () => ctx,
        order: () => ctx,
        limit: () => ctx,
        maybeSingle: () => {
          bump();
          const d = dataFor();
          return Promise.resolve({ data: d.rows[0] ?? null, error: d.error });
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        upsert: (row: any) => {
          fake.upserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then: (onF: (v: any) => unknown, onR?: (e: unknown) => unknown) => {
          bump();
          const d = dataFor();
          return Promise.resolve({ data: d.rows, error: d.error }).then(onF, onR);
        },
      };
      return ctx;
    },
  }),
}));

import {
  lerAprendizadoAtivo,
  definirAprendizadoAtivo,
  obterAdmin,
  _resetAprendizadoConfigCache,
} from "../src/services/aprendizado.service";

beforeEach(() => {
  fake.config = { ativo: false };
  fake.configError = null;
  fake.playbook = [];
  fake.jobs = [];
  fake.upserts = [];
  fake.selectCount = {};
  _resetAprendizadoConfigCache();
});

describe("lerAprendizadoAtivo", () => {
  it("FAIL-CLOSED: erro de leitura → false e NÃO cacheia (re-tenta na próxima)", async () => {
    fake.configError = { message: "boom" };
    expect(await lerAprendizadoAtivo()).toBe(false);
    // próxima leitura, já sem erro e com ativo=true → deve voltar a consultar.
    fake.configError = null;
    fake.config = { ativo: true };
    expect(await lerAprendizadoAtivo()).toBe(true);
    expect(fake.selectCount["aprendizado_config"]).toBe(2);
  });

  it("ativo=true → true; 2ª chamada dentro do TTL usa cache (sem nova query)", async () => {
    fake.config = { ativo: true };
    expect(await lerAprendizadoAtivo()).toBe(true);
    expect(await lerAprendizadoAtivo()).toBe(true);
    expect(fake.selectCount["aprendizado_config"]).toBe(1);
    // após reset, re-consulta.
    _resetAprendizadoConfigCache();
    expect(await lerAprendizadoAtivo()).toBe(true);
    expect(fake.selectCount["aprendizado_config"]).toBe(2);
  });

  it("linha ausente (data=null) → false", async () => {
    fake.config = null;
    expect(await lerAprendizadoAtivo()).toBe(false);
  });
});

describe("definirAprendizadoAtivo", () => {
  it("faz upsert na singleton e reflete na hora (cache atualizado, sem query extra)", async () => {
    await definirAprendizadoAtivo(true, "a@b.com");
    expect(fake.upserts).toHaveLength(1);
    expect(fake.upserts[0]!.table).toBe("aprendizado_config");
    expect(fake.upserts[0]!.row).toMatchObject({ id: true, ativo: true, atualizado_por: "a@b.com" });
    // leitura seguinte vem do cache setado pelo definir (não consulta o banco).
    expect(await lerAprendizadoAtivo()).toBe(true);
    expect(fake.selectCount["aprendizado_config"] ?? 0).toBe(0);
  });
});

describe("obterAdmin", () => {
  it("habilitado espelha o toggle do banco", async () => {
    fake.config = { ativo: true };
    expect((await obterAdmin()).habilitado).toBe(true);
    _resetAprendizadoConfigCache();
    fake.config = { ativo: false };
    expect((await obterAdmin()).habilitado).toBe(false);
  });
});
