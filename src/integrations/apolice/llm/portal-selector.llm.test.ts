// Resolver de seletor por LLM: escolhe entre CANDIDATOS reais (enum de índices) —
// nunca inventa. Mock do client Anthropic → determinístico. Cobre escolha válida,
// índice fora da lista (anti-alucinação → null) e lista vazia → null.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetEnvCache } from "../../../config/env";

const create = vi.fn();
vi.mock("../../claude/mapper-resolver.client", () => ({
  getMapperResolverClient: () => ({ messages: { create } }),
}));

import { escolherSeletorComLLM } from "./portal-selector.llm";

function envMin(): void {
  process.env.WA_ENABLED = "true";
  process.env.WA_AUTH_ENCRYPTION_KEY = "x".repeat(44);
  process.env.SUPABASE_URL = "http://localhost:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SUPABASE_ANON_KEY = "anon";
  process.env.ANTHROPIC_API_KEY = "k";
  _resetEnvCache();
}

function respComIdx(idx: number) {
  return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "escolher_elemento", input: { idx, confianca: 0.9 } }] };
}

const candidatos = [
  { seletor: "#login", descricao: "input[type=text] usuario" },
  { seletor: 'button:has-text("Emitir")', descricao: "button Emitir" },
];

describe("escolherSeletorComLLM", () => {
  beforeEach(() => {
    create.mockReset();
    envMin();
  });
  afterEach(() => _resetEnvCache());

  it("escolhe o candidato indicado pelo índice", async () => {
    create.mockResolvedValue(respComIdx(1));
    const r = await escolherSeletorComLLM({ acaoDescricao: "Botão emitir", candidatos });
    expect(r.seletor).toBe('button:has-text("Emitir")');
  });

  it("índice fora da lista → null (anti-alucinação)", async () => {
    create.mockResolvedValue(respComIdx(5));
    expect((await escolherSeletorComLLM({ acaoDescricao: "x", candidatos })).seletor).toBeNull();
  });

  it("idx -1 (nenhum serve) → null", async () => {
    create.mockResolvedValue(respComIdx(-1));
    expect((await escolherSeletorComLLM({ acaoDescricao: "x", candidatos })).seletor).toBeNull();
  });

  it("sem candidatos → null sem chamar o LLM", async () => {
    const r = await escolherSeletorComLLM({ acaoDescricao: "x", candidatos: [] });
    expect(r.seletor).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});
