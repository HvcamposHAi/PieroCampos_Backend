/**
 * Regressão do modo holding (humano assumiu) e mudo (bloqueado_vip):
 *  - holding_humano: a Bia RESPONDE (não fica calada), mas NÃO coleta, NÃO muda
 *    estado e NÃO dispara cotação.
 *  - mudo: a Bia não responde (Claude nem é chamado).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conversa: null as any,
  chamarBia: vi.fn(),
}));

vi.mock("../src/integrations/whatsapp/supabase", () => ({
  getSupabaseAdmin: () => {
    const conversa = h.conversa;
    return {
      from(table: string) {
        let op: "select" | "update" | "insert" = "select";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let payload: any = null;
        const ctx = {
          select: () => ctx,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          update: (p: any) => {
            op = "update";
            payload = p;
            return ctx;
          },
          insert: () => {
            op = "insert";
            return ctx;
          },
          eq: () => ctx,
          in: () => ctx,
          order: () => ctx,
          limit: () => ctx,
          async maybeSingle() {
            if (op === "update") {
              Object.assign(conversa, payload);
              return { data: null, error: null };
            }
            if (table === "conversas") return { data: { ...conversa }, error: null };
            return { data: null, error: null };
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          then(onF: (v: any) => unknown, onR?: (e: unknown) => unknown) {
            let res: unknown;
            if (op === "update") {
              Object.assign(conversa, payload);
              res = { error: null };
            } else if (op === "insert") {
              res = { error: null };
            } else {
              res = { data: table === "mensagens" ? [] : null, error: null };
            }
            return Promise.resolve(res).then(onF, onR);
          },
        };
        return ctx;
      },
    };
  },
}));

vi.mock("../src/integrations/claude/claude.client", () => ({ chamarBia: h.chamarBia }));
vi.mock("../src/services/rag.service", () => ({
  buscarContextoRAG: async () => ({ cliente: null }),
  montarContextoRAG: () => "",
}));

import { processarMensagem } from "../src/services/bot.service";
import { _resetEnvCache } from "../src/config/env";

beforeEach(() => {
  process.env.BIA_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.WA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "false";
  _resetEnvCache();
  h.chamarBia.mockReset();
});

describe("modo holding_humano", () => {
  it("responde sem coletar, sem mudar estado e sem disparar cotação", async () => {
    h.conversa = {
      id: "conv1",
      cliente_id: "cli1",
      estado: "humano_assumiu",
      categoria: "renovacao",
      dados_coletados: {},
      dados_bot: {},
    };
    h.chamarBia.mockResolvedValueOnce({
      texto: "Um corretor já está cuidando do seu caso 🙂",
      camposExtraidos: { segurado: "Tentativa" }, // deve ser ignorado em holding
      modalidadeEscolhida: null,
      paradaPorMaxTokens: false,
      uso: { input_tokens: 1, output_tokens: 1 },
    });

    const textos: string[] = [];
    await processarMensagem({
      canalId: "canal1",
      conversaId: "conv1",
      jidRemoto: "5541@s.whatsapp.net",
      textoCliente: "obrigado pela ajuda",
      enviar: async (t) => {
        textos.push(t);
      },
    });

    expect(h.chamarBia).toHaveBeenCalledTimes(1);
    expect(textos).toHaveLength(1);
    expect(textos[0]).toContain("corretor");
    // Não coletou e não avançou estado.
    expect(Object.keys(h.conversa.dados_coletados)).toHaveLength(0);
    expect(h.conversa.estado).toBe("humano_assumiu");
  });
});

describe("modo mudo", () => {
  it("bloqueado_vip → não chama Claude e não responde", async () => {
    h.conversa = {
      id: "conv1",
      cliente_id: "cli1",
      estado: "bloqueado_vip",
      categoria: "renovacao",
      dados_coletados: {},
      dados_bot: {},
    };
    const textos: string[] = [];
    await processarMensagem({
      canalId: "canal1",
      conversaId: "conv1",
      jidRemoto: "5541@s.whatsapp.net",
      textoCliente: "oi",
      enviar: async (t) => {
        textos.push(t);
      },
    });
    expect(h.chamarBia).not.toHaveBeenCalled();
    expect(textos).toHaveLength(0);
  });
});
