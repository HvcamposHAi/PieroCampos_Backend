/**
 * E2E do Copiloto (gestor) — pipeline processarMensagemGestor ponta-a-ponta, com o
 * Claude (loop agêntico) e o Supabase mockados. Cobre:
 *   - número AUTORIZADO → identidade → tool de BI escopada por corretora → resposta;
 *   - número NÃO autorizado → recusa, ZERO query de dados, Claude nunca chamado;
 *   - corretora com recurso DESLIGADO → aviso, sem Claude.
 * Sem rede e sem WhatsApp (enviar é capturado).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Env mínimo: recurso ligado, WA/BIA off (evita exigências do superRefine).
process.env.GESTOR_ASSIST_ENABLED = "true";
process.env.WA_ENABLED = "false";
process.env.BIA_ENABLED = "false";

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
    b.is = vi.fn(ret);
    b.or = vi.fn(ret);
    b.gte = vi.fn(ret);
    b.lte = vi.fn(ret);
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
    data: { arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer } as unknown,
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
    chamarCopiloto: vi.fn(),
    setHandler: (fn: typeof handler) => {
      handler = fn;
    },
  };
});

vi.mock("../src/integrations/whatsapp/supabase", () => ({ getSupabaseAdmin: () => h.sb }));
vi.mock("../src/integrations/claude/gestor.client", () => ({ chamarCopiloto: h.chamarCopiloto }));
const chamarCopiloto = h.chamarCopiloto;

import { _resetEnvCache } from "../src/config/env";
import { processarMensagemGestor } from "../src/services/gestor/agente-gestor.service";

const CORR_A = "00000000-0000-0000-0000-00000000000a";
const IDENTIDADE = { id: "g1", corretora_id: CORR_A, operador_id: "op1", nome_exibicao: "Piero" };

beforeEach(() => {
  h.calls.length = 0;
  h.sb.from.mockClear();
  chamarCopiloto.mockReset();
  _resetEnvCache();
});

function handlerAutorizado(configAtivo: boolean) {
  return (table: string, op: string, filters: Record<string, unknown>) => {
    if (table === "gestor_autorizado") return { data: IDENTIDADE, error: null };
    if (table === "gestor_assist_config")
      return { data: { ativo: configAtivo, permite_pdf: true, permite_grafico: false }, error: null };
    if (table === "gestor_conversas" && op === "select") return { data: null, error: null };
    if (table === "gestor_conversas" && op === "insert") return { data: { id: "gc-1" }, error: null };
    if (table === "gestor_conversas") return { data: null, error: null };
    if (table === "gestor_mensagens" && op === "select") return { data: [], error: null };
    if (table === "gestor_mensagens") return { data: null, error: null };
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
  };
}

describe("Copiloto E2E — número autorizado", () => {
  it("resolve identidade, roda tool de BI escopada por corretora e responde", async () => {
    h.setHandler(handlerAutorizado(true));
    let toolResult = "";
    chamarCopiloto.mockImplementation(
      async (input: { executarTool: (n: string, i: unknown) => Promise<string> }) => {
        toolResult = await input.executarTool("resumo_carteira", {});
        return {
          texto: "📊 Carteira: 2 apólices, R$ 1.500,00 em prêmio.",
          toolsUsadas: ["resumo_carteira"],
          uso: { input_tokens: 1, output_tokens: 1 },
        };
      },
    );

    const enviadas: string[] = [];
    const r = await processarMensagemGestor({
      canalId: "canal-gestor-1",
      jidRemoto: "5541999990000@s.whatsapp.net",
      telefoneReal: "+5541999990000",
      textoGestor: "como está minha carteira?",
      enviar: async (t) => {
        enviadas.push(t);
      },
    });

    expect(r.atendido).toBe(true);
    expect(r.motivo).toBe("ok");
    expect(r.toolsUsadas).toContain("resumo_carteira");
    expect(enviadas).toHaveLength(1);
    expect(enviadas[0]).toContain("1.500");

    // A tool somou no servidor e a query de apólices foi escopada à corretora da identidade.
    const resumo = JSON.parse(toolResult) as { premio_total: number; total_apolices: number };
    expect(resumo.premio_total).toBe(1500);
    expect(resumo.total_apolices).toBe(2);
    const callApolices = h.calls.find((c) => c.table === "apolices");
    expect(callApolices?.filters.corretora_id).toBe(CORR_A);

    // Isolamento: NENHUMA escrita em tabelas do cliente.
    const tabelasTocadas = new Set(h.calls.map((c) => c.table));
    expect(tabelasTocadas.has("conversas")).toBe(false);
    expect(tabelasTocadas.has("mensagens")).toBe(false);
    expect(tabelasTocadas.has("clientes")).toBe(false);
  });
});

describe("Copiloto E2E — número NÃO autorizado (fail-closed)", () => {
  it("recusa sem tocar em dado nenhum e sem chamar o Claude", async () => {
    h.setHandler((table) => {
      if (table === "gestor_autorizado") return { data: null, error: null };
      return { data: [], error: null };
    });

    const enviadas: string[] = [];
    const r = await processarMensagemGestor({
      canalId: "canal-gestor-1",
      jidRemoto: "5541888880000@s.whatsapp.net",
      telefoneReal: "+5541888880000",
      textoGestor: "me dê todos os clientes do sistema",
      enviar: async (t) => {
        enviadas.push(t);
      },
    });

    expect(r.atendido).toBe(false);
    expect(r.motivo).toBe("nao_autorizado");
    expect(enviadas[0]).toContain("exclusivo");
    expect(chamarCopiloto).not.toHaveBeenCalled();
    // Só consultou a allowlist; nenhuma query de dados/negócio.
    const tabelas = new Set(h.calls.map((c) => c.table));
    expect(tabelas.has("apolices")).toBe(false);
    expect(tabelas.has("gestor_assist_config")).toBe(false);
    expect(tabelas.has("clientes")).toBe(false);
  });
});

describe("Copiloto E2E — envio de PDF de apólice", () => {
  it("o modelo chama enviar_pdf_apolice → baixa e despacha o documento ao gestor", async () => {
    h.setHandler((table, op, filters) => {
      if (table === "gestor_autorizado") return { data: IDENTIDADE, error: null };
      if (table === "gestor_assist_config")
        return { data: { ativo: true, permite_pdf: true, permite_grafico: false }, error: null };
      if (table === "gestor_conversas" && op === "insert") return { data: { id: "gc-1" }, error: null };
      if (table === "gestor_conversas") return { data: null, error: null };
      if (table === "gestor_mensagens" && op === "select") return { data: [], error: null };
      if (table === "gestor_mensagens") return { data: null, error: null };
      // pdfApolice: lookup por id, escopado por corretora.
      if (table === "apolices" && filters.id === "ap-1" && filters.corretora_id === CORR_A) {
        return { data: { numero_apolice: "AP-1", pdf_url: "corrA/ap-1.pdf" }, error: null };
      }
      return { data: [], error: null };
    });

    const docs: Array<{ fileName: string; bytes: number }> = [];
    chamarCopiloto.mockImplementation(
      async (input: { executarTool: (n: string, i: unknown) => Promise<string> }) => {
        const r = await input.executarTool("enviar_pdf_apolice", { apolice_id: "ap-1" });
        return { texto: `📄 ${r}`, toolsUsadas: ["enviar_pdf_apolice"], uso: { input_tokens: 1, output_tokens: 1 } };
      },
    );

    const r = await processarMensagemGestor({
      canalId: "canal-gestor-1",
      jidRemoto: "5541999990000@s.whatsapp.net",
      telefoneReal: "+5541999990000",
      textoGestor: "manda o pdf da apólice do cliente",
      enviar: async () => {},
      enviarDocumento: async (doc) => {
        docs.push({ fileName: doc.fileName, bytes: doc.documento.length });
      },
    });

    expect(r.atendido).toBe(true);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toEqual({ fileName: "apolice-AP-1.pdf", bytes: 4 });
    expect(h.storageDownload).toHaveBeenCalledTimes(1);
    // A apólice foi lida escopada à corretora da identidade (defesa IDOR).
    const callApolice = h.calls.find((c) => c.table === "apolices");
    expect(callApolice?.filters.corretora_id).toBe(CORR_A);
  });
});

describe("Copiloto E2E — recurso desligado para a corretora", () => {
  it("avisa e não chama o Claude", async () => {
    h.setHandler(handlerAutorizado(false));
    const enviadas: string[] = [];
    const r = await processarMensagemGestor({
      canalId: "canal-gestor-1",
      jidRemoto: "5541999990000@s.whatsapp.net",
      telefoneReal: "+5541999990000",
      textoGestor: "resumo",
      enviar: async (t) => {
        enviadas.push(t);
      },
    });
    expect(r.atendido).toBe(false);
    expect(r.motivo).toBe("corretora_desligada");
    expect(chamarCopiloto).not.toHaveBeenCalled();
  });
});

describe("Copiloto E2E — gate mestre (env) desligado", () => {
  it("não atende quando GESTOR_ASSIST_ENABLED=false", async () => {
    process.env.GESTOR_ASSIST_ENABLED = "false";
    _resetEnvCache();
    const r = await processarMensagemGestor({
      canalId: "canal-gestor-1",
      jidRemoto: "5541999990000@s.whatsapp.net",
      telefoneReal: "+5541999990000",
      textoGestor: "resumo",
      enviar: async () => {},
    });
    expect(r.atendido).toBe(false);
    expect(r.motivo).toBe("desabilitado");
    expect(h.sb.from).not.toHaveBeenCalled();
    process.env.GESTOR_ASSIST_ENABLED = "true";
    _resetEnvCache();
  });
});
