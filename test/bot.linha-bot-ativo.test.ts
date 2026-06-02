/**
 * Master switch da Bia por LINHA (canais.bot_ativo).
 *  - bot_ativo=false → silêncio total: processarMensagem NÃO chama Claude, NÃO
 *    envia, NÃO detecta handoff (gate anterior a tudo, por canalId).
 *  - bot_ativo=true / null / erro de leitura → FAIL-OPEN: fluxo normal segue.
 * Também cobre `lerBotAtivoCanal` (semântica fail-open isolada).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conversa: null as any,
  // valor devolvido por select em `canais` (bot_ativo); ou erro simulado.
  canalBotAtivo: true as boolean | null,
  canalErro: null as { message: string } | null,
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
            if (table === "canais") {
              if (h.canalErro) return { data: null, error: h.canalErro };
              return { data: { bot_ativo: h.canalBotAtivo }, error: null };
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
import { lerBotAtivoCanal } from "../src/integrations/whatsapp/persistence";
import { _resetEnvCache } from "../src/config/env";

const RESP = {
  texto: "Oi! Como posso ajudar?",
  camposExtraidos: {},
  modalidadeEscolhida: null,
  paradaPorMaxTokens: false,
  uso: { input_tokens: 1, output_tokens: 1 },
};

beforeEach(() => {
  process.env.BIA_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.WA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "false";
  _resetEnvCache();
  h.chamarBia.mockReset();
  h.canalBotAtivo = true;
  h.canalErro = null;
  h.conversa = {
    id: "conv1",
    cliente_id: "cli1",
    estado: "bot_ativo",
    categoria: "seguro_novo",
    dados_coletados: {},
    dados_bot: {},
  };
});

async function rodar(): Promise<string[]> {
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
  return textos;
}

describe("gate por linha — bot_ativo=false → silêncio total", () => {
  it("não chama Claude e não envia nada", async () => {
    h.canalBotAtivo = false;
    h.chamarBia.mockResolvedValue({ ...RESP });
    const textos = await rodar();
    expect(h.chamarBia).not.toHaveBeenCalled();
    expect(textos).toHaveLength(0);
  });

  it("silencia mesmo num estado que normalmente seria ativo (bot_ativo)", async () => {
    h.canalBotAtivo = false;
    h.conversa.estado = "bot_ativo";
    const textos = await rodar();
    expect(textos).toHaveLength(0);
  });
});

describe("gate por linha — fail-open", () => {
  it("bot_ativo=true → fluxo normal (Claude chamado, responde)", async () => {
    h.canalBotAtivo = true;
    h.chamarBia.mockResolvedValue({ ...RESP });
    const textos = await rodar();
    expect(h.chamarBia).toHaveBeenCalledTimes(1);
    expect(textos).toHaveLength(1);
  });

  it("bot_ativo=null (coluna ausente/legado) → trata como ligado", async () => {
    h.canalBotAtivo = null;
    h.chamarBia.mockResolvedValue({ ...RESP });
    const textos = await rodar();
    expect(h.chamarBia).toHaveBeenCalledTimes(1);
    expect(textos).toHaveLength(1);
  });

  it("erro de leitura do canal → trata como ligado (não cala por falha de infra)", async () => {
    h.canalErro = { message: "boom" };
    h.chamarBia.mockResolvedValue({ ...RESP });
    const textos = await rodar();
    expect(h.chamarBia).toHaveBeenCalledTimes(1);
    expect(textos).toHaveLength(1);
  });
});

describe("lerBotAtivoCanal — semântica isolada", () => {
  it("false explícito → false", async () => {
    h.canalBotAtivo = false;
    expect(await lerBotAtivoCanal("canal1")).toBe(false);
  });

  it("true → true", async () => {
    h.canalBotAtivo = true;
    expect(await lerBotAtivoCanal("canal1")).toBe(true);
  });

  it("null → true (fail-open)", async () => {
    h.canalBotAtivo = null;
    expect(await lerBotAtivoCanal("canal1")).toBe(true);
  });

  it("erro → true (fail-open)", async () => {
    h.canalErro = { message: "boom" };
    expect(await lerBotAtivoCanal("canal1")).toBe(true);
  });

  it("canalId vazio → true (sem consulta)", async () => {
    expect(await lerBotAtivoCanal("")).toBe(true);
  });
});
