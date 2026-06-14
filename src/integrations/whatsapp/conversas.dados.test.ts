// Edição manual ("preencher") e fila do bot ("pedir ao bot") respeitam o SISTEMA
// de cotação da corretora. Regressão do bug "chave_invalida"/"nenhuma_chave_valida"
// para data_nascimento/sexo (campos exclusivos do Aggilizador). Usa o getRoteiro
// REAL (não mockado) e mocka só o Supabase admin e lerSistemaDoCanal.
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const fromResults: Array<{ data: unknown; error: unknown }> = [];
  function builder(result: { data: unknown; error: unknown }) {
    const b: Record<string, unknown> = { then: (r: (v: unknown) => void) => r(result) };
    b.select = vi.fn(() => b);
    b.update = vi.fn(() => b);
    b.eq = vi.fn(() => b);
    b.order = vi.fn(() => b);
    b.maybeSingle = vi.fn(() => b);
    return b;
  }
  const sb = {
    from: vi.fn(() => builder(fromResults.length ? fromResults.shift()! : { data: null, error: null })),
  };
  const lerSistemaDoCanal = vi.fn();
  return { fromResults, sb, lerSistemaDoCanal };
});

vi.mock("./supabase", () => ({ getSupabaseAdmin: () => h.sb }));
vi.mock("../../services/agente-config.service", () => ({ lerSistemaDoCanal: h.lerSistemaDoCanal }));

import { editarDadosColetados, enfileirarCampoForcado } from "./conversas.dados";

const CONVERSA = {
  id: "conv-1",
  categoria: "renovacao",
  canal_id: "canal-1",
  operador_id: "op-1",
  dados_coletados: {},
  dados_bot: {},
};

beforeEach(() => {
  h.fromResults.length = 0;
  h.sb.from.mockClear();
  h.lerSistemaDoCanal.mockReset();
});

describe("enfileirarCampoForcado (pedir ao bot)", () => {
  it("Aggilizador: aceita data_nascimento e enfileira", async () => {
    h.lerSistemaDoCanal.mockResolvedValue("aggilizador");
    h.fromResults.push({ data: CONVERSA, error: null }); // carregar
    h.fromResults.push({ data: null, error: null }); // update
    const out = await enfileirarCampoForcado({
      conversaId: "conv-1",
      chave: "data_nascimento",
      porEmail: "x@y.com",
      agoraIso: "2026-06-14T00:00:00Z",
    });
    expect(out).toEqual({ ok: true, fila: ["data_nascimento"] });
  });

  it("Segfy: rejeita data_nascimento com chave_invalida", async () => {
    h.lerSistemaDoCanal.mockResolvedValue("segfy");
    h.fromResults.push({ data: CONVERSA, error: null }); // carregar
    const out = await enfileirarCampoForcado({
      conversaId: "conv-1",
      chave: "data_nascimento",
      porEmail: "x@y.com",
      agoraIso: "2026-06-14T00:00:00Z",
    });
    expect(out).toEqual({ ok: false, erro: "chave_invalida" });
  });
});

describe("editarDadosColetados (preencher manual)", () => {
  it("Aggilizador: grava data_nascimento (não vai p/ ignorados)", async () => {
    h.lerSistemaDoCanal.mockResolvedValue("aggilizador");
    h.fromResults.push({ data: CONVERSA, error: null }); // carregar
    h.fromResults.push({ data: null, error: null }); // update
    const out = await editarDadosColetados({
      conversaId: "conv-1",
      campos: { data_nascimento: "01/01/1990" },
      porEmail: "x@y.com",
      agoraIso: "2026-06-14T00:00:00Z",
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.atualizados).toContain("data_nascimento");
      expect(out.ignorados).not.toContain("data_nascimento");
    }
  });

  it("Segfy: rejeita data_nascimento (nenhuma_chave_valida)", async () => {
    h.lerSistemaDoCanal.mockResolvedValue("segfy");
    h.fromResults.push({ data: CONVERSA, error: null }); // carregar
    const out = await editarDadosColetados({
      conversaId: "conv-1",
      campos: { data_nascimento: "01/01/1990" },
      porEmail: "x@y.com",
      agoraIso: "2026-06-14T00:00:00Z",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.erro).toBe("nenhuma_chave_valida");
      expect(out.ignorados).toContain("data_nascimento");
    }
  });
});
