/**
 * Aprendizado — camada Claude. Cobre:
 *  - chamarBia: bloco APRENDIZADO entra cacheado entre PERSONALIZAÇÃO e DINÂMICO;
 *    AUSENTE → array de system byte-idêntico ao de hoje (guarda de regressão);
 *  - destilar: saída estruturada via forced tool; refusal/sem tool → null.
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
import { destilar, _resetAprendizadoClient } from "../src/integrations/claude/aprendizado.client";
import { _resetEnvCache } from "../src/config/env";

const USO = { input_tokens: 1, output_tokens: 1 };
const RESP_FINAL = { stop_reason: "end_turn", usage: USO, content: [{ type: "text", text: "oi" }] };

beforeEach(() => {
  process.env.BIA_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.APRENDIZADO_MODEL = "claude-sonnet-4-5-20250929";
  process.env.WA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "false";
  _resetEnvCache();
  _resetClaudeClient();
  _resetAprendizadoClient();
  mockCreate.mockReset();
});

describe("chamarBia + bloco APRENDIZADO", () => {
  it("SEM systemAprendizado → 2 blocos (idêntico ao atual)", async () => {
    mockCreate.mockResolvedValueOnce(RESP_FINAL);
    await chamarBia({ systemBase: "base", systemDinamico: "din", historico: [{ role: "user", content: "oi" }] });
    const arg = mockCreate.mock.calls[0]![0];
    expect(arg.system).toHaveLength(2);
  });

  it("COM systemAprendizado → bloco cacheado entre PERSONALIZAÇÃO e DINÂMICO", async () => {
    mockCreate.mockResolvedValueOnce(RESP_FINAL);
    await chamarBia({
      systemBase: "base",
      systemDinamico: "din",
      historico: [{ role: "user", content: "oi" }],
      systemPersonalizacao: "PERSONA",
      systemAprendizado: "DIRETRIZES",
    });
    const arg = mockCreate.mock.calls[0]![0];
    expect(arg.system).toHaveLength(4); // base + persona + aprendizado + dinamico
    expect(arg.system[2].text).toBe("DIRETRIZES");
    expect(arg.system[2].cache_control).toEqual({ type: "ephemeral" });
    expect(arg.system[3].text).toBe("din"); // dinâmico permanece por último e sem cache
    expect(arg.system[3].cache_control).toBeUndefined();
  });

  it("COM systemAprendizado mas SEM personalização → 3 blocos (base + aprendizado + dinamico)", async () => {
    mockCreate.mockResolvedValueOnce(RESP_FINAL);
    await chamarBia({
      systemBase: "base",
      systemDinamico: "din",
      historico: [{ role: "user", content: "oi" }],
      systemAprendizado: "DIRETRIZES",
    });
    const arg = mockCreate.mock.calls[0]![0];
    expect(arg.system).toHaveLength(3);
    expect(arg.system[1].text).toBe("DIRETRIZES");
  });
});

describe("destilar", () => {
  it("retorna diretrizes a partir do forced tool", async () => {
    mockCreate.mockResolvedValueOnce({
      stop_reason: "tool_use",
      usage: USO,
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "registrar_aprendizado",
          input: {
            padroes_que_convertem: [{ diretriz: "Saudar pelo nome", evidencia: "fechou mais" }],
            antipadroes_a_evitar: [{ diretriz: "Pedir CPF cedo demais", evidencia: "cliente travou" }],
            resumo: "ok",
          },
        },
      ],
    });
    const d = await destilar({ segmento: "renovacao", sucessos: ["t"], falhas: [{ motivo: "x", transcricao: "t" }] });
    expect(d?.padroes_que_convertem[0]?.diretriz).toBe("Saudar pelo nome");
    expect(d?.antipadroes_a_evitar[0]?.diretriz).toBe("Pedir CPF cedo demais");
    // forçou a tool
    const arg = mockCreate.mock.calls[0]![0];
    expect(arg.tool_choice).toEqual({ type: "tool", name: "registrar_aprendizado" });
  });

  it("recusa do modelo → null", async () => {
    mockCreate.mockResolvedValueOnce({ stop_reason: "refusal", usage: USO, content: [] });
    expect(await destilar({ segmento: "geral", sucessos: [], falhas: [] })).toBeNull();
  });

  it("sem tool_use → null", async () => {
    mockCreate.mockResolvedValueOnce({ stop_reason: "end_turn", usage: USO, content: [{ type: "text", text: "x" }] });
    expect(await destilar({ segmento: "geral", sucessos: [], falhas: [] })).toBeNull();
  });

  it("clampa itens malformados (descarta sem diretriz)", async () => {
    mockCreate.mockResolvedValueOnce({
      stop_reason: "tool_use",
      usage: USO,
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "registrar_aprendizado",
          input: {
            padroes_que_convertem: [{ evidencia: "sem diretriz" }, { diretriz: "válida", evidencia: "" }],
            antipadroes_a_evitar: "não é array",
            resumo: 123,
          },
        },
      ],
    });
    const d = await destilar({ segmento: "geral", sucessos: [], falhas: [] });
    expect(d?.padroes_que_convertem).toHaveLength(1);
    expect(d?.padroes_que_convertem[0]?.diretriz).toBe("válida");
    expect(d?.antipadroes_a_evitar).toEqual([]);
    expect(d?.resumo).toBe("");
  });
});
