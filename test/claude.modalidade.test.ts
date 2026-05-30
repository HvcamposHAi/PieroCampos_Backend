/**
 * Testa que `chamarBia` captura a tool `escolher_modalidade` e ainda devolve o
 * texto. O SDK Anthropic é mockado (sem rede). Cobre o loop com 2 tools.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_opts: any) {}
  },
}));

import { chamarBia, _resetClaudeClient } from "../src/integrations/claude/claude.client";
import { _resetEnvCache } from "../src/config/env";

const USO = { input_tokens: 10, output_tokens: 5 };

beforeEach(() => {
  process.env.BIA_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.WA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "false";
  _resetEnvCache();
  _resetClaudeClient();
  mockCreate.mockReset();
});

describe("chamarBia + escolher_modalidade", () => {
  it("captura modalidade='formulario' e retorna o texto final", async () => {
    mockCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        usage: USO,
        content: [
          { type: "tool_use", id: "t1", name: "escolher_modalidade", input: { modalidade: "formulario" } },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        usage: USO,
        content: [{ type: "text", text: "Combinado! Vou te enviar a planilha." }],
      });

    const r = await chamarBia({
      systemBase: "base",
      systemDinamico: "dinamico",
      historico: [{ role: "user", content: "prefiro formulário" }],
    });

    expect(r.modalidadeEscolhida).toBe("formulario");
    expect(r.texto).toContain("planilha");
    expect(mockCreate).toHaveBeenCalledTimes(2);
    // As duas tools são oferecidas ao modelo.
    const toolsArg = mockCreate.mock.calls[0]![0].tools as Array<{ name: string }>;
    expect(toolsArg.map((t) => t.name).sort()).toEqual(
      ["atualizar_dados", "escolher_modalidade"].sort(),
    );
  });

  it("sem tool de modalidade → modalidadeEscolhida=null e extrai campos", async () => {
    mockCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        usage: USO,
        content: [
          { type: "tool_use", id: "t2", name: "atualizar_dados", input: { campos: { segurado: "Ana" } } },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        usage: USO,
        content: [{ type: "text", text: "Obrigada, Ana!" }],
      });

    const r = await chamarBia({ systemBase: "b", systemDinamico: "d", historico: [{ role: "user", content: "sou a Ana" }] });
    expect(r.modalidadeEscolhida).toBeNull();
    expect(r.camposExtraidos.segurado).toBe("Ana");
  });
});
