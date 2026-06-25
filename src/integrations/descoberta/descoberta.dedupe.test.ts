import { describe, it, expect, vi } from "vitest";
import { criarJobConstrucao, cancelarJob, salvarAdapterRascunho, buscarConstrucaoEmVoo } from "./descoberta.persistence";
import type { AdapterSpec } from "./descoberta.types";

/** sb fake: fila de resultados consumida por maybeSingle/single/await. */
function fakeSb() {
  const results: Array<{ data: unknown; error: unknown }> = [];
  const calls = { from: [] as string[], insert: [] as unknown[], update: [] as unknown[] };
  function builder() {
    const result = results.length ? results.shift()! : { data: null, error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    const ret = (): unknown => b;
    b.select = vi.fn(ret);
    b.eq = vi.fn(ret);
    b.limit = vi.fn(ret);
    b.order = vi.fn(ret);
    b.maybeSingle = vi.fn(async () => result);
    b.single = vi.fn(async () => result);
    b.insert = vi.fn((v: unknown) => (calls.insert.push(v), b));
    b.update = vi.fn((v: unknown) => (calls.update.push(v), b));
    b.then = (resolve: (v: unknown) => void): void => resolve(result);
    return b;
  }
  const sb = { from: vi.fn((t: string) => (calls.from.push(t), builder())) };
  return { results, calls, sb };
}

const chave = { seguradoraConfigId: "11111111-1111-1111-1111-111111111111", sistema: "HDI", ramo: "auto", objetivo: "validar_estrutura" };

describe("criarJobConstrucao — idempotência (anti-duplicação)", () => {
  it("REUSA o job em-voo (não duplica)", async () => {
    const { results, calls, sb } = fakeSb();
    results.push({ data: { id: "job-existente" }, error: null }); // buscarConstrucaoEmVoo
    const r = await criarJobConstrucao("corr-1", chave, { sb });
    expect(r).toEqual({ jobId: "job-existente", jaEmVoo: true });
    expect(calls.insert).toHaveLength(0); // NÃO inseriu novo
  });

  it("cria novo quando NÃO há em-voo", async () => {
    const { results, calls, sb } = fakeSb();
    results.push({ data: null, error: null }); // sem em-voo
    results.push({ data: { id: "job-novo" }, error: null }); // insert
    const r = await criarJobConstrucao("corr-1", chave, { sb });
    expect(r).toEqual({ jobId: "job-novo", jaEmVoo: false });
    expect(calls.insert).toHaveLength(1);
    // grava as colunas de chave (p/ o índice único)
    const ins = calls.insert[0] as Record<string, unknown>;
    expect(ins.seguradora_config_id).toBe(chave.seguradoraConfigId);
    expect(ins.objetivo).toBe(chave.objetivo);
    expect(ins.status).toBe("andamento");
  });
});

describe("cancelarJob", () => {
  it("atualiza status→cancelado só de jobs em andamento (eq status andamento)", async () => {
    const { results, calls, sb } = fakeSb();
    results.push({ data: null, error: null });
    await cancelarJob("corr-1", "22222222-2222-2222-2222-222222222222", { sb });
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]).toMatchObject({ status: "cancelado", etapa: "cancelado" });
  });
});

describe("salvarAdapterRascunho", () => {
  it("grava em_construcao + inativo, sem desativar o validado vigente", async () => {
    const { results, calls, sb } = fakeSb();
    results.push({ data: { versao: 2 }, error: null }); // proximaVersaoSeguradora
    results.push({ data: { id: "ct-1" }, error: null }); // insert contrato
    results.push({ data: { id: "ad-1" }, error: null }); // insert adapter
    const spec = { sistema: "HDI", ramo: "auto", operacao: "apolice", objetivo: "apolice", versao: 1, entradaObrigatoria: [], passos: [], passosRpa: [] } as AdapterSpec;
    const r = await salvarAdapterRascunho("corr-1", { seguradoraConfigId: chave.seguradoraConfigId, sistema: "HDI", ramo: "auto", objetivo: "apolice", spec }, { sb });
    expect(r.adapterId).toBe("ad-1");
    expect(r.versao).toBe(3); // max+1
    const insAdapter = calls.insert[1] as Record<string, unknown>;
    expect(insAdapter.status).toBe("em_construcao");
    expect(insAdapter.ativo).toBe(false);
    // NÃO houve update (não desativou concorrentes) — só inserts
    expect(calls.update).toHaveLength(0);
  });
});

describe("buscarConstrucaoEmVoo", () => {
  it("devolve o id quando há em-voo", async () => {
    const { results, sb } = fakeSb();
    results.push({ data: { id: "jx" }, error: null });
    expect(await buscarConstrucaoEmVoo("c", "s", "auto", "apolice", { sb })).toEqual({ id: "jx" });
  });
});
