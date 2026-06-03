/**
 * Testa que `chamarBia` oferece a tool `confirmar_revisao` só quando
 * permitirRevisao=true e captura `mudou` em `revisaoMudou`, além de extrair os
 * campos alterados no mesmo turno. SDK Anthropic mockado (sem rede).
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

describe("chamarBia + confirmar_revisao", () => {
  it("permitirRevisao=true → tool oferecida; captura mudou=false", async () => {
    mockCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        usage: USO,
        content: [{ type: "tool_use", id: "r1", name: "confirmar_revisao", input: { mudou: false } }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        usage: USO,
        content: [{ type: "text", text: "Perfeito, sigo então!" }],
      });

    const r = await chamarBia({
      systemBase: "b",
      systemDinamico: "d",
      historico: [{ role: "user", content: "está tudo certo" }],
      permitirRevisao: true,
    });

    expect(r.revisaoMudou).toBe(false);
    const toolsArg = mockCreate.mock.calls[0]![0].tools as Array<{ name: string }>;
    expect(toolsArg.map((t) => t.name)).toContain("confirmar_revisao");
  });

  it("mudou=true + atualizar_dados no mesmo turno popula camposExtraidos", async () => {
    mockCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        usage: USO,
        content: [
          { type: "tool_use", id: "r2", name: "confirmar_revisao", input: { mudou: true } },
          { type: "tool_use", id: "r3", name: "atualizar_dados", input: { campos: { numero: "99" } } },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        usage: USO,
        content: [{ type: "text", text: "Atualizei o número!" }],
      });

    const r = await chamarBia({
      systemBase: "b",
      systemDinamico: "d",
      historico: [{ role: "user", content: "mudei o número para 99" }],
      permitirRevisao: true,
    });

    expect(r.revisaoMudou).toBe(true);
    expect(r.camposExtraidos.numero).toBe("99");
  });

  it("sem permitirRevisao → tool NÃO é oferecida e revisaoMudou=null", async () => {
    mockCreate.mockResolvedValueOnce({
      stop_reason: "end_turn",
      usage: USO,
      content: [{ type: "text", text: "Oi!" }],
    });

    const r = await chamarBia({
      systemBase: "b",
      systemDinamico: "d",
      historico: [{ role: "user", content: "oi" }],
    });

    expect(r.revisaoMudou).toBeNull();
    const toolsArg = mockCreate.mock.calls[0]![0].tools as Array<{ name: string }>;
    expect(toolsArg.map((t) => t.name)).not.toContain("confirmar_revisao");
  });
});
