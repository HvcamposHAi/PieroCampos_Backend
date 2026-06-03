/**
 * Aprendizado contínuo — funções puras + leituras com o supabase fakeado.
 * Cobre o coração da feature: rotulagem sucesso/falha, redação de PII,
 * serialização do playbook, segmentação, leitura fail-open e idempotência do job.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const fake = vi.hoisted(() => ({
  data: {} as Record<string, Array<Record<string, unknown>>>,
  selectError: {} as Record<string, { message: string } | null>,
  insertError: {} as Record<string, { code?: string; message?: string } | null>,
  inserted: [] as Array<{ table: string; rows: unknown }>,
}));

vi.mock("../src/integrations/whatsapp/supabase", () => ({
  getSupabaseAdmin: () => ({
    from(table: string) {
      const sel = { data: fake.data[table] ?? [], error: fake.selectError[table] ?? null };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx: any = {
        select: () => ctx,
        eq: () => ctx,
        neq: () => ctx,
        is: () => ctx,
        in: () => ctx,
        gte: () => ctx,
        lt: () => ctx,
        order: () => ctx,
        limit: () => ctx,
        maybeSingle: () => Promise.resolve({ data: sel.data[0] ?? null, error: sel.error }),
        single: () => Promise.resolve({ data: sel.data[0] ?? null, error: sel.error }),
        insert: (rows: unknown) => {
          fake.inserted.push({ table, rows });
          const err = fake.insertError[table] ?? null;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const after: any = {
            select: () => ({
              single: () => Promise.resolve({ data: { id: "job-1" }, error: err }),
            }),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            then: (onF: (v: any) => unknown) => Promise.resolve({ data: null, error: err }).then(onF),
          };
          return after;
        },
        update: () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const upd: any = {
            eq: () => upd,
            is: () => upd,
            lt: () => upd,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            then: (onF: (v: any) => unknown) => Promise.resolve({ data: null, error: null }).then(onF),
          };
          return upd;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then: (onF: (v: any) => unknown) => Promise.resolve(sel).then(onF),
      };
      return ctx;
    },
  }),
}));

const { mockDestilar } = vi.hoisted(() => ({ mockDestilar: vi.fn() }));
vi.mock("../src/integrations/claude/aprendizado.client", () => ({
  destilar: mockDestilar,
}));

import {
  rotularResultado,
  redigirPII,
  montarTextoPlaybook,
  montarSegmentos,
  obterPlaybookAtivoTexto,
  dispararDistillacao,
  type ConversaRotulada,
  type FunilConversa,
} from "../src/services/aprendizado.service";
import { _resetEnvCache } from "../src/config/env";

function funil(over: Partial<FunilConversa> = {}): FunilConversa {
  return { estado: "encerrado", cotacoes: [], propostas: [], temApolice: false, ...over };
}

beforeEach(() => {
  fake.data = {};
  fake.selectError = {};
  fake.insertError = {};
  fake.inserted = [];
  process.env.APRENDIZADO_ENABLED = "true";
  process.env.APRENDIZADO_MODEL = "claude-sonnet-4-5-20250929";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.WA_ENABLED = "false";
  process.env.BIA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "false";
  _resetEnvCache();
  mockDestilar.mockReset();
});

describe("rotularResultado", () => {
  it("apólice emitida → sucesso", () => {
    expect(rotularResultado(funil({ temApolice: true })).resultado).toBe("sucesso");
  });
  it("proposta aprovada/emitida → sucesso", () => {
    expect(rotularResultado(funil({ propostas: [{ status: "emitida" }] })).resultado).toBe("sucesso");
    expect(rotularResultado(funil({ propostas: [{ status: "aprovada" }] })).resultado).toBe("sucesso");
  });
  it("cotação aceita → sucesso", () => {
    expect(
      rotularResultado(funil({ cotacoes: [{ status: "concluida", aceito_em: "2026-06-01" }] })).resultado,
    ).toBe("sucesso");
  });
  it("estado apolice_emitida → sucesso mesmo sem linhas de funil", () => {
    expect(rotularResultado(funil({ estado: "apolice_emitida" })).resultado).toBe("sucesso");
  });
  it("cotação com erro/expirada → falha", () => {
    expect(rotularResultado(funil({ cotacoes: [{ status: "erro", aceito_em: null }] })).resultado).toBe("falha");
    expect(rotularResultado(funil({ cotacoes: [{ status: "expirada", aceito_em: null }] })).resultado).toBe("falha");
  });
  it("proposta recusada → falha", () => {
    expect(rotularResultado(funil({ propostas: [{ status: "recusada" }] })).resultado).toBe("falha");
  });
  it("encerrado sem desfecho → falha", () => {
    expect(rotularResultado(funil({ estado: "encerrado" })).resultado).toBe("falha");
  });
  it("humano_assumiu sem desfecho → indeterminado", () => {
    expect(rotularResultado(funil({ estado: "humano_assumiu" })).resultado).toBe("indeterminado");
  });
  it("sucesso tem prioridade sobre sinais de falha", () => {
    // proposta recusada coexistindo com apólice (raro): vence o sucesso.
    const r = rotularResultado(funil({ temApolice: true, propostas: [{ status: "recusada" }] }));
    expect(r.resultado).toBe("sucesso");
  });
});

describe("redigirPII", () => {
  it("mascara email, cpf, telefone, cep e placa", () => {
    const t = redigirPII("contato ana@x.com cpf 123.456.789-00 tel (41) 99876-5432 cep 80000-000 placa ABC1D23");
    expect(t).not.toContain("ana@x.com");
    expect(t).not.toContain("123.456.789-00");
    expect(t).not.toContain("99876-5432");
    expect(t).not.toContain("80000-000");
    expect(t).not.toContain("ABC1D23");
    expect(t).toContain("[email]");
    expect(t).toContain("[cpf]");
  });
});

describe("montarTextoPlaybook", () => {
  it("diretrizes vazias → string vazia", () => {
    expect(montarTextoPlaybook({ padroes_que_convertem: [], antipadroes_a_evitar: [], resumo: "" })).toBe("");
  });
  it("monta seções e redige PII das diretrizes", () => {
    const txt = montarTextoPlaybook({
      padroes_que_convertem: [{ diretriz: "Confirmar o CEP cedo (ex: 80000-000)", evidencia: "x" }],
      antipadroes_a_evitar: [{ diretriz: "Demorar a oferecer cotação", evidencia: "y" }],
      resumo: "ok",
    });
    expect(txt).toContain("DIRETRIZES APRENDIDAS");
    expect(txt).toContain("POTENCIALIZAR");
    expect(txt).toContain("EVITAR");
    expect(txt).toContain("Demorar a oferecer cotação");
    expect(txt).not.toContain("80000-000"); // PII redigida
  });
  it("é determinístico (mesma entrada → mesma saída) para estabilidade de cache", () => {
    const d = {
      padroes_que_convertem: [{ diretriz: "A", evidencia: "" }],
      antipadroes_a_evitar: [{ diretriz: "B", evidencia: "" }],
      resumo: "",
    };
    expect(montarTextoPlaybook(d)).toBe(montarTextoPlaybook(d));
  });
});

describe("montarSegmentos", () => {
  function rot(categoria: string | null, resultado: "sucesso" | "falha"): ConversaRotulada {
    return {
      conversaId: `c-${Math.round(Math.random() * 1e9)}`,
      clienteId: null,
      categoria,
      ramo: null,
      resultado,
      motivo: "",
      transcricao: "t",
    };
  }
  it("categoria com sinal (≥4, ≥1 sucesso e ≥1 falha) vira segmento próprio", () => {
    const itens = [
      rot("renovacao", "sucesso"),
      rot("renovacao", "sucesso"),
      rot("renovacao", "falha"),
      rot("renovacao", "falha"),
    ];
    const segs = montarSegmentos(itens);
    expect(segs.find((s) => s.categoria === "renovacao")).toBeTruthy();
  });
  it("categoria fraca cai no bucket global (categoria=null)", () => {
    const itens = [
      rot("endosso", "sucesso"), // só 1 endosso → fraco
      rot("renovacao", "sucesso"),
      rot("renovacao", "falha"),
      rot("renovacao", "sucesso"),
      rot("renovacao", "falha"),
    ];
    // endosso (1) é fraco → vai p/ global; mas global precisa de sinal próprio.
    const itens2 = [...itens, rot("outro", "falha"), rot("duvida", "sucesso"), rot("nao_renovado", "falha"), rot("endosso", "sucesso")];
    const segs = montarSegmentos(itens2);
    expect(segs.some((s) => s.categoria === "renovacao")).toBe(true);
    expect(segs.some((s) => s.categoria === null)).toBe(true);
  });
  it("ignora indeterminados", () => {
    const ind: ConversaRotulada = { ...rot("renovacao", "sucesso"), resultado: "indeterminado" as never };
    const segs = montarSegmentos([ind]);
    expect(segs).toHaveLength(0);
  });
});

describe("obterPlaybookAtivoTexto", () => {
  it("prefere a versão específica da categoria sobre a global", async () => {
    fake.data["aprendizado_playbook"] = [
      { categoria: "renovacao", ramo: null, texto_prompt: "ESPECIFICO" },
      { categoria: null, ramo: null, texto_prompt: "GLOBAL" },
    ];
    expect(await obterPlaybookAtivoTexto("renovacao")).toBe("ESPECIFICO");
  });
  it("cai na global quando não há específica", async () => {
    fake.data["aprendizado_playbook"] = [{ categoria: null, ramo: null, texto_prompt: "GLOBAL" }];
    expect(await obterPlaybookAtivoTexto("endosso")).toBe("GLOBAL");
  });
  it("sem ativa correspondente → string vazia", async () => {
    fake.data["aprendizado_playbook"] = [{ categoria: "renovacao", ramo: null, texto_prompt: "X" }];
    expect(await obterPlaybookAtivoTexto("endosso")).toBe("");
  });
  it("FAIL-OPEN: erro na leitura → string vazia (Bia roda como hoje)", async () => {
    fake.selectError["aprendizado_playbook"] = { message: "boom" };
    expect(await obterPlaybookAtivoTexto("renovacao")).toBe("");
  });
});

describe("dispararDistillacao — idempotência", () => {
  it("dois jobs simultâneos: o 2º recebe job_em_andamento (violação de unicidade)", async () => {
    fake.insertError["aprendizado_job"] = { code: "23505", message: "duplicate" };
    const r = await dispararDistillacao({ disparadoPor: "admin@x.com" });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("job_em_andamento");
    // Nunca chegou a destilar.
    expect(mockDestilar).not.toHaveBeenCalled();
  });
});
