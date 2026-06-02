/**
 * E2E do comportamento configurável da Bia por linha (fakes; sem rede).
 *  1. Canal COM override ativo (entusiasta/criativo) → processarMensagem lê a
 *     config e passa systemPersonalizacao (com a persona) + temperature 0.9 ao
 *     chamarBia; dados_coletados ficam intactos (roteiro preservado).
 *  2. Canal SEM nenhuma config → chamarBia recebe systemPersonalizacao=undefined
 *     e temperature=undefined (idêntico ao comportamento atual = zero impacto).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conversa: null as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configRows: [] as Array<Record<string, any>>,
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
          is: () => ctx,
          or: () => ctx,
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
            } else if (table === "canal_agente_config") {
              res = { data: h.configRows, error: null };
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

const RESP = {
  texto: "Olá! 😊",
  camposExtraidos: {},
  modalidadeEscolhida: null,
  confirmarCotacao: null,
  consentimentoLgpd: null,
  paradaPorMaxTokens: false,
  uso: { input_tokens: 1, output_tokens: 1 },
};

function configRow(over: Record<string, unknown>) {
  return {
    canal_id: null,
    ativo: true,
    tom_voz: "proximo_caloroso",
    persona: null,
    saudacao: null,
    exemplos: null,
    variar_texto: true,
    criatividade: "equilibrado",
    atualizado_em: null,
    atualizado_por: null,
    ...over,
  };
}

beforeEach(() => {
  process.env.BIA_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.WA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "false";
  _resetEnvCache();
  h.chamarBia.mockReset();
  h.chamarBia.mockResolvedValue(RESP);
});

async function mandar() {
  await processarMensagem({
    canalId: h.conversa.canal_id,
    conversaId: "conv1",
    jidRemoto: "5541@s.whatsapp.net",
    textoCliente: "oi",
    enviar: async () => {},
  });
}

describe("E2E — comportamento da Bia por linha", () => {
  it("canal com override ativo → personaliza prompt e usa temperature 0.9", async () => {
    h.conversa = {
      id: "conv1",
      cliente_id: "cli1",
      canal_id: "canalX",
      estado: "bot_ativo",
      categoria: "seguro_novo",
      dados_coletados: { segurado: "Ana" },
      dados_bot: {},
    };
    h.configRows = [
      configRow({ canal_id: null }),
      configRow({ canal_id: "canalX", tom_voz: "entusiasta", persona: "seja super animada", criatividade: "criativo" }),
    ];

    await mandar();

    expect(h.chamarBia).toHaveBeenCalledTimes(1);
    const arg = h.chamarBia.mock.calls[0]![0];
    expect(arg.temperature).toBe(0.9);
    expect(arg.systemPersonalizacao).toContain("seja super animada");
    expect(arg.systemPersonalizacao).toContain("entusiasta");
    // roteiro intacto: nada removido dos dados coletados.
    expect(h.conversa.dados_coletados).toEqual({ segurado: "Ana" });
  });

  it("canal sem config → sem personalização e sem temperature (zero impacto)", async () => {
    h.conversa = {
      id: "conv1",
      cliente_id: "cli1",
      canal_id: "canalSemConfig",
      estado: "bot_ativo",
      categoria: "seguro_novo",
      dados_coletados: {},
      dados_bot: {},
    };
    h.configRows = [];

    await mandar();

    expect(h.chamarBia).toHaveBeenCalledTimes(1);
    const arg = h.chamarBia.mock.calls[0]![0];
    expect(arg.temperature).toBeUndefined();
    expect(arg.systemPersonalizacao).toBeUndefined();
  });
});
