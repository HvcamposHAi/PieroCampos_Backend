/**
 * Integração em processarMensagem (SDK/DB/RAG mockados):
 *  - QUEBRA-LOOP: obrigatório travado no topo por 2 turnos sem preencher → escala
 *    para humano (estado humano_assumiu + MENSAGEM_COLETA_TRAVADA), NUNCA loop.
 *  - NOVO VEÍCULO: a tool cotar_outro_veiculo limpa SÓ os campos de veículo
 *    (mantém os pessoais), entra em revisão "novo veículo" e volta a coletar.
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
import { MENSAGEM_COLETA_TRAVADA } from "../src/services/handoff.service";

const RESP_BASE = {
  texto: "ok",
  camposExtraidos: {},
  modalidadeEscolhida: null,
  confirmarCotacao: null,
  consentimentoLgpd: null,
  revisaoMudou: null,
  cotarOutroVeiculo: null,
  paradaPorMaxTokens: false,
  uso: { input_tokens: 1, output_tokens: 1 },
};

// Segfy seguro_novo completo MENOS profissao (último obrigatório a faltar).
const QUASE_COMPLETO_SEM_PROFISSAO = {
  segurado: "João", estado_civil: "casado", cep: "80000", numero: "10",
  utilizacao_veiculo: "particular", email: "j@x.com", rg: "123",
  dados_veiculo_fipe: "Onix 2020", cpf: "111.111.111-11", placa: "ABC1234",
};

beforeEach(() => {
  process.env.BIA_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.WA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "false";
  _resetEnvCache();
  h.chamarBia.mockReset();
});

async function rodar(texto: string, jidRemoto = "5541@s.whatsapp.net") {
  const textos: string[] = [];
  await processarMensagem({
    canalId: "canal1",
    conversaId: "conv1",
    jidRemoto,
    textoCliente: texto,
    enviar: async (t) => {
      textos.push(t);
    },
  });
  return textos;
}

describe("auditor de coleta em processarMensagem", () => {
  it("sem progresso (2º turno) → FORÇA a pergunta do obrigatório, NÃO escala (não frustra)", async () => {
    h.conversa = {
      id: "conv1", cliente_id: "cli1", canal_id: "canal1",
      estado: "bot_ativo", categoria: "seguro_novo",
      dados_coletados: { ...QUASE_COMPLETO_SEM_PROFISSAO },
      dados_bot: { coleta_top: "profissao", coleta_reps: 1 },
      operador_id: null,
    };
    h.chamarBia.mockResolvedValueOnce({ ...RESP_BASE });

    const textos = await rodar("sei lá");

    // NÃO escalou — segue coletando, forçando a pergunta do campo que falta.
    expect(h.conversa.estado).toBe("bot_ativo");
    expect(textos).not.toContain(MENSAGEM_COLETA_TRAVADA);
    expect(h.conversa.dados_bot.coleta_forcar).toBe("profissao");
  });

  it("escala só como ÚLTIMO RECURSO (campo perguntado direto vezes demais)", async () => {
    h.conversa = {
      id: "conv1", cliente_id: "cli1", canal_id: "canal1",
      estado: "bot_ativo", categoria: "seguro_novo",
      dados_coletados: { ...QUASE_COMPLETO_SEM_PROFISSAO },
      // já vínhamos FORÇANDO profissao e perguntando direto várias vezes.
      dados_bot: { coleta_top: "profissao", coleta_reps: 2, coleta_forcar: "profissao", coleta_forcar_tent: 3 },
      operador_id: null,
    };
    h.chamarBia.mockResolvedValueOnce({ ...RESP_BASE });

    const textos = await rodar("não quero informar");

    expect(h.conversa.estado).toBe("humano_assumiu");
    expect(textos).toContain(MENSAGEM_COLETA_TRAVADA);
  });
});

describe("telefone de contato automático", () => {
  it("dá 1 chance à Bia e, se ela não registrar, captura o número do WhatsApp", async () => {
    h.conversa = {
      id: "conv1", cliente_id: "cli1", canal_id: "canal1",
      estado: "bot_ativo", categoria: "seguro_novo",
      dados_coletados: { segurado: "João" },
      dados_bot: {},
      operador_id: null,
    };
    h.chamarBia.mockResolvedValue({ ...RESP_BASE }); // a Bia nunca registra o telefone

    // 1º turno: apenas sinaliza (telefone_sugerido) — dá à Bia a chance de confirmar.
    await rodar("oi", "5541999998888@s.whatsapp.net");
    expect(h.conversa.dados_bot.telefone_sugerido).toBe(true);
    expect(h.conversa.dados_coletados.telefone_contato).toBeUndefined();

    // 2º turno: a Bia segue sem registrar → captura o número (não deixa vazio).
    await rodar("oi de novo", "5541999998888@s.whatsapp.net");
    expect(typeof h.conversa.dados_coletados.telefone_contato).toBe("string");
    expect(h.conversa.dados_coletados.telefone_contato).toContain("99999");
  });
});

describe("novo veículo em processarMensagem", () => {
  it("cotar_outro_veiculo limpa só o veículo, mantém pessoais, entra em revisão", async () => {
    h.conversa = {
      id: "conv1", cliente_id: "cli1", canal_id: "canal1",
      estado: "aguardando_confirmacao_cotacao", categoria: "seguro_novo",
      dados_coletados: {
        ...QUASE_COMPLETO_SEM_PROFISSAO, profissao: "eng",
        bonus: "5", utilizacao_veiculo: "particular",
      },
      dados_bot: {},
      operador_id: null,
    };
    h.chamarBia.mockResolvedValueOnce({ ...RESP_BASE, cotarOutroVeiculo: true });

    await rodar("quero cotar outro carro");

    // veículo limpo
    expect(h.conversa.dados_coletados.placa).toBeUndefined();
    expect(h.conversa.dados_coletados.dados_veiculo_fipe).toBeUndefined();
    expect(h.conversa.dados_coletados.utilizacao_veiculo).toBeUndefined();
    expect(h.conversa.dados_coletados.bonus).toBeUndefined();
    // pessoais mantidos
    expect(h.conversa.dados_coletados.cpf).toBe("111.111.111-11");
    expect(h.conversa.dados_coletados.segurado).toBe("João");
    // revisão "novo veículo" + volta a coletar
    expect(h.conversa.dados_bot.novo_veiculo).toBe(true);
    expect(h.conversa.dados_bot.revisao_pendente).toBe(true);
    expect(h.conversa.estado).toBe("bot_ativo");
  });
});
