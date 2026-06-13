/**
 * Clonagem automática do estilo do operador — sanitização/parse (puros), coleta do
 * CORPUS de mensagens reais (supabase fakeado) e orquestração (estilo.client mockado).
 * Garante: redação de PII em toda fonte, isolamento multi-tenant, identificação do
 * operador em export do WhatsApp, truncamento e tratamento de falha do destilador.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const fake = vi.hoisted(() => ({
  data: {} as Record<string, Array<Record<string, unknown>>>,
  selectError: {} as Record<string, { message: string } | null>,
}));

vi.mock("../src/integrations/whatsapp/supabase", () => ({
  getSupabaseAdmin: () => ({
    from(table: string) {
      const sel = { data: fake.data[table] ?? [], error: fake.selectError[table] ?? null };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx: any = {
        select: () => ctx,
        eq: () => ctx,
        is: () => ctx,
        in: () => ctx,
        gte: () => ctx,
        order: () => ctx,
        limit: () => ctx,
        maybeSingle: () => Promise.resolve({ data: sel.data[0] ?? null, error: sel.error }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then: (onF: (v: any) => unknown) => Promise.resolve(sel).then(onF),
      };
      return ctx;
    },
  }),
}));

const mockDestilar = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../src/integrations/claude/estilo.client", () => ({
  destilarEstilo: (amostras: string[]) => mockDestilar.fn(amostras),
}));

import {
  coletarAmostrasDaLinha,
  sanitizarTextoColado,
  decodificarTxt,
  parseConversa,
  gerarEstilo,
} from "../src/services/estilo-clone.service";

const CORR = "00000000-0000-0000-0000-000000000001";
const CANAL = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  fake.data = {};
  fake.selectError = {};
  mockDestilar.fn.mockReset();
});

describe("sanitizarTextoColado", () => {
  it("redige PII e descarta linhas vazias/curtas + dedup", () => {
    const out = sanitizarTextoColado(
      "Opa, meu CPF é 123.456.789-09\n\nb\nLiga pra (41) 99999-8888\nOpa, meu CPF é 123.456.789-09",
    );
    expect(out).toContain("Opa, meu CPF é [cpf]");
    expect(out.some((l) => l.includes("[telefone]"))).toBe(true);
    expect(out.every((l) => l.length >= 2)).toBe(true);
    // dedup: a linha de CPF repetida aparece uma vez só
    expect(out.filter((l) => l.includes("[cpf]")).length).toBe(1);
  });
});

describe("decodificarTxt", () => {
  it("decodifica base64 de texto", () => {
    const b64 = Buffer.from("Oi tudo bem?", "utf8").toString("base64");
    expect(decodificarTxt(b64)).toBe("Oi tudo bem?");
  });
  it("rejeita binário (byte nulo) e vazio → null", () => {
    expect(decodificarTxt(Buffer.from([0x4f, 0x00, 0x41]).toString("base64"))).toBeNull();
    expect(decodificarTxt("")).toBeNull();
  });
});

describe("parseConversa (export WhatsApp)", () => {
  it("Android: detecta remetentes e agrupa falas", () => {
    const txt =
      "12/06/2026 14:32 - João Corretor: Opa, tudo certo?\n" +
      "12/06/2026 14:33 - Cliente Maria: Oi, quero renovar\n" +
      "12/06/2026 14:34 - João Corretor: Show, já te ajudo 👊";
    const p = parseConversa(txt)!;
    expect(p.remetentes).toEqual(["João Corretor", "Cliente Maria"]);
    expect(p.porRemetente["João Corretor"]).toHaveLength(2);
  });
  it("iOS: formato com colchetes", () => {
    const txt =
      "[12/06/2026, 14:32:11] João: Bora resolver\n[12/06/2026, 14:33:00] Maria: Ok";
    const p = parseConversa(txt)!;
    expect(p.remetentes).toContain("João");
  });
  it("texto avulso (sem cabeçalho) → null", () => {
    expect(parseConversa("Opa tudo bem\nbora resolver isso rapidinho")).toBeNull();
  });
});

describe("coletarAmostrasDaLinha (corpus + escopo)", () => {
  it("canal de OUTRA corretora (maybeSingle null) → [] (multi-tenant)", async () => {
    fake.data.canais = [];
    fake.data.operador_estilo_corpus = [{ corpo: "não deveria vir" }];
    expect(await coletarAmostrasDaLinha(CORR, CANAL)).toEqual([]);
  });
  it("lê o corpus da linha e redige PII", async () => {
    fake.data.canais = [{ id: CANAL }];
    fake.data.operador_estilo_corpus = [
      { corpo: "Fechou! Qualquer coisa chama 😉" },
      { corpo: "Manda no zap (41) 99999-0000" },
    ];
    const out = await coletarAmostrasDaLinha(CORR, CANAL);
    expect(out).toContain("Fechou! Qualquer coisa chama 😉");
    expect(out.some((l) => l.includes("[telefone]"))).toBe(true);
  });
});

describe("gerarEstilo (orquestração)", () => {
  it("export com vários remetentes e sem escolha → precisaRemetente", async () => {
    const txt =
      "12/06/2026 14:32 - João: Opa\n12/06/2026 14:33 - Maria: Oi\n12/06/2026 14:34 - João: Beleza";
    const r = await gerarEstilo({ corretoraId: CORR, fonte: "texto", texto: txt });
    expect(r.precisaRemetente).toBe(true);
    expect(r.remetentes).toEqual(["João", "Maria"]);
    expect(mockDestilar.fn).not.toHaveBeenCalled();
  });
  it("export com remetente escolhido → destila SÓ as falas dele", async () => {
    mockDestilar.fn.mockResolvedValueOnce(["Opa!", "Beleza 👊"]);
    const txt =
      "12/06/2026 14:32 - João: Opa\n12/06/2026 14:33 - Maria: Oi\n12/06/2026 14:34 - João: Beleza";
    const r = await gerarEstilo({
      corretoraId: CORR,
      fonte: "texto",
      texto: txt,
      remetenteOperador: "João",
    });
    expect(mockDestilar.fn).toHaveBeenCalledOnce();
    const amostrasRecebidas = mockDestilar.fn.mock.calls[0][0] as string[];
    expect(amostrasRecebidas).toEqual(["Opa", "Beleza"]); // sem a fala da Maria
    expect(r.amostra).toBe("Opa!\nBeleza 👊");
  });
  it("texto avulso: destila tudo (sem identificação de lado)", async () => {
    mockDestilar.fn.mockResolvedValueOnce(["linha"]);
    const r = await gerarEstilo({ corretoraId: CORR, fonte: "texto", texto: "Opa, beleza?" });
    expect(r.amostra).toBe("linha");
    expect(r.nLinhasFonte).toBe(1);
  });
  it("sem amostras → { amostra:'', nLinhasFonte:0 } e NÃO chama o destilador", async () => {
    const r = await gerarEstilo({ corretoraId: CORR, fonte: "texto", texto: "   " });
    expect(r).toMatchObject({ amostra: "", nLinhasFonte: 0 });
    expect(mockDestilar.fn).not.toHaveBeenCalled();
  });
  it("destilador indisponível (null) → lança 'destilacao_indisponivel'", async () => {
    mockDestilar.fn.mockResolvedValueOnce(null);
    await expect(
      gerarEstilo({ corretoraId: CORR, fonte: "texto", texto: "Oi, tudo certo?" }),
    ).rejects.toThrow("destilacao_indisponivel");
  });
  it("trunca a amostra final em 8000 caracteres", async () => {
    mockDestilar.fn.mockResolvedValueOnce([`${"x".repeat(5000)}`, `${"y".repeat(5000)}`]);
    const r = await gerarEstilo({ corretoraId: CORR, fonte: "texto", texto: "uma mensagem" });
    expect(r.amostra.length).toBeLessThanOrEqual(8000);
  });
});
