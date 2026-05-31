/**
 * Regressão do modo holding e mudo:
 *  - holding (cotação/equipe, humano assumiu, apólice, VIP): a Bia RESPONDE
 *    (nunca fica calada), mas NÃO coleta, NÃO muda estado e NÃO dispara cotação.
 *  - mudo (encerrado): a Bia não responde (Claude nem é chamado).
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

const RESP_HOLDING = {
  texto: "Pode ficar tranquilo! Já estamos cuidando disso e te retorno por aqui 🙂",
  camposExtraidos: { segurado: "Tentativa" }, // deve ser IGNORADO em holding
  modalidadeEscolhida: null,
  paradaPorMaxTokens: false,
  uso: { input_tokens: 1, output_tokens: 1 },
};

describe("modo holding — RESPONDE sem coletar/avançar", () => {
  for (const estado of ["aguardando_cotacao", "cotacao_enviada", "humano_assumiu", "bloqueado_vip"]) {
    it(`${estado}: chama Claude, envia resposta, estado e dados intactos`, async () => {
      h.conversa = {
        id: "conv1",
        cliente_id: "cli1",
        estado,
        categoria: "seguro_novo",
        dados_coletados: {},
        dados_bot: {},
      };
      h.chamarBia.mockResolvedValueOnce({ ...RESP_HOLDING });

      const textos: string[] = [];
      await processarMensagem({
        canalId: "canal1",
        conversaId: "conv1",
        jidRemoto: "5541@s.whatsapp.net",
        textoCliente: "oi, qual o status?",
        enviar: async (t) => {
          textos.push(t);
        },
      });

      expect(h.chamarBia, estado).toHaveBeenCalledTimes(1);
      expect(textos, estado).toHaveLength(1);
      // Não coletou (merge pulado) e não avançou estado.
      expect(Object.keys(h.conversa.dados_coletados), estado).toHaveLength(0);
      expect(h.conversa.estado, estado).toBe(estado);
    });
  }

  it("responde a mensagens repetidas (sem anti-spam que silencia)", async () => {
    h.conversa = {
      id: "conv1",
      cliente_id: "cli1",
      estado: "aguardando_cotacao",
      categoria: "seguro_novo",
      dados_coletados: {},
      dados_bot: {},
    };
    h.chamarBia.mockResolvedValue({ ...RESP_HOLDING });
    const textos: string[] = [];
    const enviar = async (t: string) => {
      textos.push(t);
    };
    for (const msg of ["oi", "qual o status?", "alô?"]) {
      await processarMensagem({
        canalId: "canal1",
        conversaId: "conv1",
        jidRemoto: "5541@s.whatsapp.net",
        textoCliente: msg,
        enviar,
      });
    }
    expect(textos).toHaveLength(3); // TODAS respondidas (antes: 1 e depois silêncio)
  });
});

describe("modo mudo", () => {
  it("encerrado → não chama Claude e não responde", async () => {
    h.conversa = {
      id: "conv1",
      cliente_id: "cli1",
      estado: "encerrado",
      categoria: "seguro_novo",
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
