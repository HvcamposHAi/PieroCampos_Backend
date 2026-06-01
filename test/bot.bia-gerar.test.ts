/**
 * gerarMensagemBia: a Bia compõe UMA mensagem proativa seguindo a instrução do
 * operador, reusando o mesmo brain (chamarBia). Não envia nem persiste — só
 * devolve o texto. Mocka Supabase (conversa + histórico vazio) e a Claude.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conversa: null as any,
  chamarBia: vi.fn(),
}));

vi.mock("../src/integrations/whatsapp/supabase", () => ({
  getSupabaseAdmin: () => ({
    from(table: string) {
      const ctx = {
        select: () => ctx,
        eq: () => ctx,
        order: () => ctx,
        limit: () => ctx,
        async maybeSingle() {
          if (table === "conversas")
            return { data: h.conversa ? { ...h.conversa } : null, error: null };
          return { data: null, error: null };
        },
        // carregarHistorico aguarda a query direto (sem maybeSingle).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then(onF: (v: any) => unknown, onR?: (e: unknown) => unknown) {
          const res = { data: table === "mensagens" ? [] : null, error: null };
          return Promise.resolve(res).then(onF, onR);
        },
      };
      return ctx;
    },
  }),
}));

vi.mock("../src/integrations/claude/claude.client", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, chamarBia: h.chamarBia };
});
vi.mock("../src/services/rag.service", () => ({
  buscarContextoRAG: async () => ({ cliente: null }),
  montarContextoRAG: () => "",
}));

import { gerarMensagemBia } from "../src/services/bot.service";
import { _resetEnvCache } from "../src/config/env";

beforeEach(() => {
  process.env.BIA_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.WA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "false";
  _resetEnvCache();
  h.chamarBia.mockReset();
  h.conversa = {
    id: "conv1",
    cliente_id: "cli1",
    estado: "humano_assumiu",
    operador_id: "op1",
    categoria: "seguro_novo",
    dados_coletados: {},
    dados_bot: {},
  };
});

const RESP = {
  texto: "Oi! Passando pra pedir os documentos do veículo 🙂",
  camposExtraidos: {},
  modalidadeEscolhida: null,
  confirmarCotacao: null,
  consentimentoLgpd: null,
  paradaPorMaxTokens: false,
  uso: { input_tokens: 1, output_tokens: 1 },
};

describe("gerarMensagemBia", () => {
  it("retorna o texto da Bia e injeta a instrução do operador no histórico", async () => {
    h.chamarBia.mockResolvedValueOnce({ ...RESP });

    const texto = await gerarMensagemBia("conv1", "peça os documentos do veículo");

    expect(texto).toBe(RESP.texto);
    expect(h.chamarBia).toHaveBeenCalledTimes(1);
    const arg = h.chamarBia.mock.calls[0]![0] as {
      historico: Array<{ role: string; content: string }>;
    };
    // Histórico vazio → 1 turno user carregando a instrução do operador.
    expect(arg.historico).toHaveLength(1);
    expect(arg.historico[0]!.role).toBe("user");
    expect(arg.historico[0]!.content).toContain("peça os documentos do veículo");
  });

  it("usa instrução default quando nenhuma é passada", async () => {
    h.chamarBia.mockResolvedValueOnce({ ...RESP });
    const texto = await gerarMensagemBia("conv1");
    expect(texto).toBe(RESP.texto);
    const arg = h.chamarBia.mock.calls[0]![0] as {
      historico: Array<{ role: string; content: string }>;
    };
    expect(arg.historico[0]!.content).toContain("INSTRUÇÃO DO OPERADOR");
  });

  it("texto vazio da Bia → retorna null (rota responde 422)", async () => {
    h.chamarBia.mockResolvedValueOnce({ ...RESP, texto: "   " });
    expect(await gerarMensagemBia("conv1")).toBeNull();
  });

  it("conversa inexistente → null", async () => {
    h.conversa = null;
    expect(await gerarMensagemBia("nao_existe")).toBeNull();
  });
});
