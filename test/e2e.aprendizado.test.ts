/**
 * E2E do aprendizado contínuo no fluxo real da Bia (fakes; sem rede).
 *  - Flag ON + conversa em modo ativo → o playbook ativo é consultado e CHEGA a
 *    chamarBia como `systemAprendizado`.
 *  - Flag OFF → o playbook NÃO é consultado e chamarBia recebe systemAprendizado
 *    indefinido (degradação ao comportamento base — zero impacto).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conversa: null as any,
  chamarBia: vi.fn(),
  obterPlaybook: vi.fn(),
  lerAtivo: vi.fn(),
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
vi.mock("../src/services/aprendizado.service", () => ({
  obterPlaybookAtivoTexto: h.obterPlaybook,
  lerAprendizadoAtivo: h.lerAtivo,
}));

import { processarMensagem } from "../src/services/bot.service";
import { _resetEnvCache } from "../src/config/env";

const RESP = {
  texto: "Olá! Como posso ajudar?",
  camposExtraidos: {},
  modalidadeEscolhida: null,
  confirmarCotacao: null,
  consentimentoLgpd: null,
  revisaoMudou: null,
  cotarOutroVeiculo: null,
  paradaPorMaxTokens: false,
  uso: { input_tokens: 1, output_tokens: 1 },
};

function novaConversa() {
  return {
    id: "conv1",
    cliente_id: "cli1",
    canal_id: "canal1",
    estado: "bot_ativo",
    operador_id: null,
    categoria: "renovacao",
    dados_coletados: {},
    dados_bot: {},
  };
}

async function mandar() {
  await processarMensagem({
    canalId: "canal1",
    conversaId: "conv1",
    jidRemoto: "5541999990000@s.whatsapp.net",
    textoCliente: "oi, quero renovar meu seguro",
    enviar: async () => {},
  });
}

beforeEach(() => {
  process.env.BIA_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.WA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "false";
  _resetEnvCache();
  h.chamarBia.mockReset();
  h.obterPlaybook.mockReset();
  h.lerAtivo.mockReset();
  h.chamarBia.mockResolvedValue(RESP);
});

describe("E2E — injeção do playbook na Bia (gateada pelo toggle do banco)", () => {
  it("toggle ON: consulta o playbook e injeta como systemAprendizado", async () => {
    h.lerAtivo.mockResolvedValue(true);
    h.obterPlaybook.mockResolvedValue("DIRETRIZES APRENDIDAS: ...");
    h.conversa = novaConversa();

    await mandar();

    expect(h.obterPlaybook).toHaveBeenCalledWith("renovacao");
    expect(h.chamarBia).toHaveBeenCalledTimes(1);
    const arg = h.chamarBia.mock.calls[0]![0];
    expect(arg.systemAprendizado).toBe("DIRETRIZES APRENDIDAS: ...");
  });

  it("toggle OFF: não consulta o playbook e systemAprendizado fica indefinido", async () => {
    h.lerAtivo.mockResolvedValue(false);
    h.conversa = novaConversa();

    await mandar();

    expect(h.obterPlaybook).not.toHaveBeenCalled();
    const arg = h.chamarBia.mock.calls[0]![0];
    expect(arg.systemAprendizado).toBeUndefined();
  });

  it("toggle ON mas playbook vazio (sem versão ativa) → systemAprendizado indefinido", async () => {
    h.lerAtivo.mockResolvedValue(true);
    h.obterPlaybook.mockResolvedValue("");
    h.conversa = novaConversa();

    await mandar();

    const arg = h.chamarBia.mock.calls[0]![0];
    expect(arg.systemAprendizado).toBeUndefined();
  });
});
