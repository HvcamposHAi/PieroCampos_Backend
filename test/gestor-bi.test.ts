/**
 * Unit do Copiloto (gestor): isolamento multi-tenant das queries de BI, derivação
 * de status de vigência e o resolver de identidade FAIL-CLOSED. Sem rede: o
 * Supabase admin é mockado e o teste inspeciona os FILTROS aplicados (prova de que
 * corretora_id entra em toda query e que clienteId é casado junto — defesa IDOR).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const calls: Array<{ table: string; op: string; filters: Record<string, unknown> }> = [];
  let handler: (table: string, op: string, filters: Record<string, unknown>) => {
    data: unknown;
    error: unknown;
  } = () => ({ data: [], error: null });
  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    let op = "select";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    const ret = (): unknown => b;
    const finish = () => {
      calls.push({ table, op, filters: { ...filters } });
      return handler(table, op, filters);
    };
    b.select = vi.fn(ret);
    b.eq = vi.fn((c: string, v: unknown) => ((filters[c] = v), b));
    b.is = vi.fn((c: string, v: unknown) => ((filters[`is_${c}`] = v), b));
    b.or = vi.fn((v: unknown) => ((filters.__or = v), b));
    b.gte = vi.fn((c: string, v: unknown) => ((filters[`gte_${c}`] = v), b));
    b.lte = vi.fn((c: string, v: unknown) => ((filters[`lte_${c}`] = v), b));
    b.order = vi.fn(ret);
    b.limit = vi.fn(ret);
    b.insert = vi.fn(() => ((op = "insert"), b));
    b.update = vi.fn(() => ((op = "update"), b));
    b.upsert = vi.fn(() => ((op = "upsert"), b));
    b.delete = vi.fn(() => ((op = "delete"), b));
    b.maybeSingle = vi.fn(() => Promise.resolve(finish()));
    b.single = vi.fn(() => Promise.resolve(finish()));
    b.then = (res?: (v: unknown) => void, rej?: (e: unknown) => void): Promise<unknown> =>
      Promise.resolve(finish()).then(res, rej);
    return b;
  }
  const storageDownload = vi.fn(async () => ({
    data: { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as unknown,
    error: null as unknown,
  }));
  const sb = {
    from: vi.fn((t: string) => builder(t)),
    storage: { from: vi.fn(() => ({ download: storageDownload })) },
  };
  return {
    calls,
    sb,
    storageDownload,
    setHandler: (fn: typeof handler) => {
      handler = fn;
    },
  };
});

vi.mock("../src/integrations/whatsapp/supabase", () => ({ getSupabaseAdmin: () => h.sb }));

import {
  apolicesDoCliente,
  buscarClientes,
  pdfApolice,
  resumoCarteira,
  statusVigencia,
} from "../src/services/gestor/gestor-bi.service";
import { montarHtmlGrafico, gerarGraficoPng } from "../src/services/gestor/gestor-grafico";
import { _resetEnvCache } from "../src/config/env";
import { resolverGestorPorTelefone } from "../src/services/gestor/gestor-identidade.service";

const CORR_A = "00000000-0000-0000-0000-00000000000a";
const CORR_B = "00000000-0000-0000-0000-00000000000b";

beforeEach(() => {
  h.calls.length = 0;
  h.sb.from.mockClear();
  h.storageDownload.mockClear();
  h.setHandler(() => ({ data: [], error: null }));
});

describe("statusVigencia (puro)", () => {
  const hoje = "2026-06-10";
  it("vencida quando fim < hoje", () => {
    expect(statusVigencia("2026-06-01", hoje)).toBe("vencida");
  });
  it("proxima_vencer quando dentro da janela de 30d", () => {
    expect(statusVigencia("2026-06-25", hoje)).toBe("proxima_vencer");
  });
  it("vigente quando além da janela", () => {
    expect(statusVigencia("2026-12-01", hoje)).toBe("vigente");
  });
});

describe("isolamento multi-tenant", () => {
  it("buscarClientes filtra SEMPRE por corretora_id", async () => {
    h.setHandler(() => ({ data: [{ id: "c1", nome: "Ana", cpf: null, telefone: null }], error: null }));
    await buscarClientes(CORR_A, "Ana");
    const call = h.calls.find((c) => c.table === "clientes");
    expect(call?.filters.corretora_id).toBe(CORR_A);
    expect(call?.filters.__or).toBeTruthy();
  });

  it("apolicesDoCliente casa cliente_id E corretora_id juntos (defesa IDOR)", async () => {
    h.setHandler(() => ({ data: [], error: null }));
    await apolicesDoCliente(CORR_A, "cliente-de-outra");
    const call = h.calls.find((c) => c.table === "apolices");
    expect(call?.filters.corretora_id).toBe(CORR_A);
    expect(call?.filters.cliente_id).toBe("cliente-de-outra");
  });

  it("resumoCarteira da corretora A não soma apólice da corretora B", async () => {
    // O mock só devolve as linhas da A; o filtro corretora_id é a garantia real.
    h.setHandler((table, _op, filters) => {
      if (table === "apolices" && filters.corretora_id === CORR_A) {
        return {
          data: [
            { ramo: "auto", seguradora: "HDI", premio_total: 1000, fim_vigencia: "2026-12-01" },
            { ramo: "auto", seguradora: "HDI", premio_total: 500, fim_vigencia: "2026-06-25" },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    });
    const resumoA = await resumoCarteira(CORR_A);
    expect(resumoA.total_apolices).toBe(2);
    expect(resumoA.premio_total).toBe(1500);
    expect(resumoA.por_ramo[0]).toMatchObject({ ramo: "auto", quantidade: 2, premio_total: 1500 });

    // Corretora B (sem linhas no mock) → zero. Prova de escopo.
    h.calls.length = 0;
    const resumoB = await resumoCarteira(CORR_B);
    expect(resumoB.total_apolices).toBe(0);
    expect(resumoB.premio_total).toBe(0);
    const callB = h.calls.find((c) => c.table === "apolices");
    expect(callB?.filters.corretora_id).toBe(CORR_B);
  });
});

describe("resolverGestorPorTelefone (fail-closed)", () => {
  it("número inválido → null SEM tocar no banco", async () => {
    const id = await resolverGestorPorTelefone("abc");
    expect(id).toBeNull();
    expect(h.sb.from).not.toHaveBeenCalled();
  });

  it("número fora da allowlist (linha vazia) → null", async () => {
    h.setHandler(() => ({ data: null, error: null }));
    const id = await resolverGestorPorTelefone("+5541999990000");
    expect(id).toBeNull();
    const call = h.calls.find((c) => c.table === "gestor_autorizado");
    expect(call?.filters.numero_e164).toBe("+5541999990000");
    expect(call?.filters.ativo).toBe(true);
  });

  it("número autorizado → identidade com corretora_id do registro", async () => {
    h.setHandler(() => ({
      data: { id: "g1", corretora_id: CORR_A, operador_id: "op1", nome_exibicao: "Piero" },
      error: null,
    }));
    const id = await resolverGestorPorTelefone("41999990000");
    expect(id).toEqual({ gestorId: "g1", corretoraId: CORR_A, operadorId: "op1", nomeExibicao: "Piero" });
  });

  it("erro de infra → null (nunca abre por dúvida)", async () => {
    h.setHandler(() => ({ data: null, error: { message: "boom" } }));
    const id = await resolverGestorPorTelefone("+5541999990000");
    expect(id).toBeNull();
  });
});

describe("pdfApolice (defesa IDOR)", () => {
  it("apólice de outra corretora (lookup vazio) → null e NÃO baixa do storage", async () => {
    h.setHandler(() => ({ data: null, error: null }));
    const pdf = await pdfApolice(CORR_A, "apolice-da-corr-B");
    expect(pdf).toBeNull();
    expect(h.storageDownload).not.toHaveBeenCalled();
    const call = h.calls.find((c) => c.table === "apolices");
    expect(call?.filters.corretora_id).toBe(CORR_A);
    expect(call?.filters.id).toBe("apolice-da-corr-B");
  });

  it("apólice sem pdf_url → null (sem download)", async () => {
    h.setHandler(() => ({ data: { numero_apolice: "AP1", pdf_url: null }, error: null }));
    const pdf = await pdfApolice(CORR_A, "ap-1");
    expect(pdf).toBeNull();
    expect(h.storageDownload).not.toHaveBeenCalled();
  });

  it("apólice válida da corretora → baixa e retorna buffer com nome derivado", async () => {
    h.setHandler(() => ({ data: { numero_apolice: "AP-999", pdf_url: "corrA/p.pdf" }, error: null }));
    const pdf = await pdfApolice(CORR_A, "ap-1");
    expect(pdf).not.toBeNull();
    expect(pdf!.fileName).toBe("apolice-AP-999.pdf");
    expect(pdf!.numeroApolice).toBe("AP-999");
    expect(pdf!.buffer.length).toBe(3);
    expect(h.storageDownload).toHaveBeenCalledTimes(1);
  });
});

describe("gerarGraficoPng (gate fail-safe)", () => {
  it("GESTOR_GRAFICO_ENABLED off → null sem subir Chromium", async () => {
    delete process.env.GESTOR_GRAFICO_ENABLED;
    _resetEnvCache();
    const png = await gerarGraficoPng({ titulo: "x", barras: [{ rotulo: "a", valor: 1 }] });
    expect(png).toBeNull();
  });

  it("montarHtmlGrafico escapa rótulos (anti-injeção de HTML)", () => {
    const html = montarHtmlGrafico({ titulo: "T<script>", barras: [{ rotulo: "<b>x</b>", valor: 10 }] });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});
