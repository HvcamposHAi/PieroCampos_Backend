/**
 * E2E "Bia sempre responde" (fakes; sem rede). Cobre os 4 cenários do plano:
 *  1. aguardando_cotacao → 1ª msg: Claude chamado, resposta enviada, estado intacto.
 *  2. 2ª e 3ª msgs seguidas: AMBAS respondem (não há mais suprimir/silêncio).
 *  3. bloqueado_vip → responde (holding); encerrado → não responde (mudo).
 *  4. confirmação → Segfy falha (null) → estado vira humano_assumiu e a Bia
 *     responde na mensagem seguinte (holding).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conversa: null as any,
  chamarBia: vi.fn(),
  dispararCotacaoSegfy: vi.fn(),
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
vi.mock("../src/services/segfy-cotacao.service", () => ({
  dispararCotacaoSegfy: h.dispararCotacaoSegfy,
}));

import { processarMensagem } from "../src/services/bot.service";
import { _resetEnvCache } from "../src/config/env";

const RESP = (texto: string, extra: Record<string, unknown> = {}) => ({
  texto,
  camposExtraidos: {},
  modalidadeEscolhida: null,
  confirmarCotacao: null,
  consentimentoLgpd: null,
  paradaPorMaxTokens: false,
  uso: { input_tokens: 1, output_tokens: 1 },
  ...extra,
});

function novaConversa(estado: string) {
  return {
    id: "conv1",
    cliente_id: "cli1",
    estado,
    categoria: "seguro_novo",
    dados_coletados: {},
    dados_bot: {},
  };
}

beforeEach(() => {
  process.env.BIA_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.WA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "false";
  _resetEnvCache();
  h.chamarBia.mockReset();
  h.dispararCotacaoSegfy.mockReset();
});

async function mandar(texto: string, textos: string[]) {
  await processarMensagem({
    canalId: "canal1",
    conversaId: "conv1",
    jidRemoto: "5541@s.whatsapp.net",
    textoCliente: texto,
    enviar: async (t) => {
      textos.push(t);
    },
  });
}

describe("E2E — Bia sempre responde", () => {
  it("1+2: aguardando_cotacao responde (Claude) e estado intacto; 3 msgs seguidas todas respondem", async () => {
    h.conversa = novaConversa("aguardando_cotacao");
    h.chamarBia.mockResolvedValue(RESP("Estamos cuidando da sua cotação 🙂"));

    const textos: string[] = [];
    await mandar("oi", textos);
    expect(h.chamarBia).toHaveBeenCalledTimes(1);
    expect(textos).toHaveLength(1);
    expect(h.conversa.estado).toBe("aguardando_cotacao");

    await mandar("qual o status?", textos);
    await mandar("alô?", textos);
    expect(textos).toHaveLength(3); // nenhuma suprimida
  });

  it("3: bloqueado_vip responde; encerrado não responde", async () => {
    h.conversa = novaConversa("bloqueado_vip");
    h.chamarBia.mockResolvedValue(RESP("Já avisei seu atendente VIP 🙂"));
    const tVip: string[] = [];
    await mandar("oi", tVip);
    expect(h.chamarBia).toHaveBeenCalledTimes(1);
    expect(tVip).toHaveLength(1);

    h.chamarBia.mockClear();
    h.conversa = novaConversa("encerrado");
    const tEnc: string[] = [];
    await mandar("oi", tEnc);
    expect(h.chamarBia).not.toHaveBeenCalled();
    expect(tEnc).toHaveLength(0);
  });

  it("4: confirmação → Segfy falha → estado vira humano_assumiu e a Bia responde na próxima", async () => {
    h.conversa = novaConversa("aguardando_confirmacao_cotacao");
    h.dispararCotacaoSegfy.mockResolvedValue(null); // cotação falha

    // turno 1: cliente confirma; Claude pede a tool confirmar_cotacao=true
    h.chamarBia.mockResolvedValueOnce(RESP("Perfeito, vou buscar as opções!", { confirmarCotacao: true }));
    const textos: string[] = [];
    await mandar("pode cotar sim", textos);

    // Falhou → escalou: estado agora é humano_assumiu (executarHandoff real mutou o store)
    expect(h.conversa.estado).toBe("humano_assumiu");

    // turno 2: cliente volta a falar → holding responde
    h.chamarBia.mockResolvedValueOnce(RESP("Um corretor está finalizando e te retorna já 🙂"));
    await mandar("e aí, saiu?", textos);
    expect(textos.length).toBeGreaterThanOrEqual(2);
    expect(h.conversa.estado).toBe("humano_assumiu");
  });
});
