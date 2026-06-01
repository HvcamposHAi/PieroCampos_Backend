/**
 * Testa a tool `consultar_cep` em `chamarBia`: quando o modelo a chama, o client
 * resolve o endereço (consultarCep mockado), grava os campos auto em
 * camposExtraidos e devolve o endereço no tool_result. SDK Anthropic mockado.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockCreate, mockConsultarCep } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockConsultarCep: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_opts: any) {}
  },
}));

vi.mock("../src/lib/cep", () => ({
  consultarCep: mockConsultarCep,
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
  mockConsultarCep.mockReset();
});

describe("chamarBia + consultar_cep", () => {
  it("oferece a tool consultar_cep ao modelo", async () => {
    mockCreate.mockResolvedValueOnce({
      stop_reason: "end_turn",
      usage: USO,
      content: [{ type: "text", text: "oi" }],
    });
    await chamarBia({ systemBase: "b", systemDinamico: "d", historico: [{ role: "user", content: "oi" }] });
    const toolsArg = mockCreate.mock.calls[0]![0].tools as Array<{ name: string }>;
    expect(toolsArg.map((t) => t.name)).toContain("consultar_cep");
  });

  it("CEP resolvido → grava logradouro/bairro/cidade/uf e devolve no tool_result", async () => {
    mockConsultarCep.mockResolvedValueOnce({
      cep: "81270320",
      logradouro: "Rua João Alencar Guimarães",
      bairro: "Cidade Industrial",
      cidade: "Curitiba",
      uf: "PR",
    });
    mockCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        usage: USO,
        content: [{ type: "tool_use", id: "c1", name: "consultar_cep", input: { cep: "81270-320" } }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        usage: USO,
        content: [{ type: "text", text: "Encontrei a Rua João Alencar Guimarães. Confirma?" }],
      });

    const r = await chamarBia({
      systemBase: "b",
      systemDinamico: "d",
      historico: [{ role: "user", content: "meu cep é 81270-320" }],
    });

    expect(mockConsultarCep).toHaveBeenCalledWith("81270-320");
    expect(r.camposExtraidos.cep).toBe("81270320");
    expect(r.camposExtraidos.logradouro).toBe("Rua João Alencar Guimarães");
    expect(r.camposExtraidos.cidade).toBe("Curitiba");
    expect(r.camposExtraidos.uf).toBe("PR");
    // O 2º turno (após tool_result) recebe o endereço como conteúdo do tool_result.
    const segundaMsgs = mockCreate.mock.calls[1]![0].messages as Array<{ role: string; content: unknown }>;
    const toolResultMsg = segundaMsgs[segundaMsgs.length - 1] as { content: Array<{ content: string }> };
    expect(toolResultMsg.content[0]!.content).toContain("Curitiba");
    expect(r.texto).toContain("Confirma");
  });

  it("CEP não encontrado → não grava campos e instrui coleta manual", async () => {
    mockConsultarCep.mockResolvedValueOnce(null);
    mockCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        usage: USO,
        content: [{ type: "tool_use", id: "c2", name: "consultar_cep", input: { cep: "00000-000" } }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        usage: USO,
        content: [{ type: "text", text: "Não achei esse CEP, pode me passar a rua?" }],
      });

    const r = await chamarBia({ systemBase: "b", systemDinamico: "d", historico: [{ role: "user", content: "cep 00000-000" }] });
    expect(r.camposExtraidos.logradouro).toBeUndefined();
    const segundaMsgs = mockCreate.mock.calls[1]![0].messages as Array<{ content: Array<{ content: string }> }>;
    const toolResultMsg = segundaMsgs[segundaMsgs.length - 1]!;
    expect(toolResultMsg.content[0]!.content).toContain("não encontrado");
  });
});
