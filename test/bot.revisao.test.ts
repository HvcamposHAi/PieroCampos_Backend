/**
 * Comportamento do gate de REVISÃO (cliente recorrente) em processarMensagem:
 *  - turno de APRESENTAÇÃO (cliente ainda não respondeu): mantém revisao_pendente
 *    e NÃO avança para a cotação, mesmo com o roteiro completo.
 *  - turno de RESPOSTA (mudou=false): limpa a flag e, completo, vai para
 *    aguardando_confirmacao_cotacao.
 *  - turno de RESPOSTA (mudou=true): mescla os campos alterados e segue.
 * SDK/DB/RAG mockados (sem rede).
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

// Todos os obrigatórios de seguro_novo preenchidos → roteiro completo.
const DADOS_COMPLETOS = {
  segurado: "João Silva",
  estado_civil: "casado",
  cep: "80000-000",
  numero: "10",
  utilizacao_veiculo: "particular",
  email: "joao@x.com",
  rg: "12345678",
  dados_veiculo_fipe: "Onix 2020",
  cpf: "111.111.111-11",
  placa: "ABC1234",
  profissao: "engenheiro",
};

function novaConversaEmRevisao(extra?: Record<string, unknown>) {
  return {
    id: "conv1",
    cliente_id: "cli1",
    canal_id: "canal1",
    estado: "bot_ativo",
    categoria: "seguro_novo",
    dados_coletados: { ...DADOS_COMPLETOS },
    dados_bot: { revisao_pendente: true, reuso_de_dados: true },
    operador_id: null,
    ...extra,
  };
}

const RESP_BASE = {
  texto: "Oi! Vi que já temos seus dados. Mudou algo?",
  camposExtraidos: {},
  modalidadeEscolhida: null,
  confirmarCotacao: null,
  consentimentoLgpd: null,
  revisaoMudou: null,
  cotarOutroVeiculo: null,
  paradaPorMaxTokens: false,
  uso: { input_tokens: 1, output_tokens: 1 },
};

async function rodar(texto: string) {
  const textos: string[] = [];
  await processarMensagem({
    canalId: "canal1",
    conversaId: "conv1",
    jidRemoto: "5541@s.whatsapp.net",
    textoCliente: texto,
    enviar: async (t) => {
      textos.push(t);
    },
  });
  return textos;
}

describe("gate de revisão (cliente recorrente)", () => {
  it("turno de apresentação: oferece confirmar_revisao e NÃO avança para a cotação", async () => {
    h.conversa = novaConversaEmRevisao();
    h.chamarBia.mockResolvedValueOnce({ ...RESP_BASE });

    const textos = await rodar("oi");

    expect(textos).toHaveLength(1);
    // chamou Claude com a tool de revisão habilitada
    expect(h.chamarBia.mock.calls[0]![0].permitirRevisao).toBe(true);
    // NÃO pulou para a cotação, mesmo com roteiro completo
    expect(h.conversa.estado).toBe("bot_ativo");
    expect(h.conversa.dados_bot.revisao_pendente).toBe(true);
    expect(h.conversa.dados_bot.revisao_tentativas).toBe(1);
  });

  it("resposta 'tudo certo' (mudou=false): limpa a flag e vai para confirmação de cotação", async () => {
    h.conversa = novaConversaEmRevisao();
    h.chamarBia.mockResolvedValueOnce({ ...RESP_BASE, revisaoMudou: false });

    await rodar("está tudo certo");

    expect(h.conversa.dados_bot.revisao_pendente).toBe(false);
    expect(h.conversa.estado).toBe("aguardando_confirmacao_cotacao");
  });

  it("resposta com mudança (mudou=true): mescla o campo alterado e segue", async () => {
    h.conversa = novaConversaEmRevisao();
    h.chamarBia.mockResolvedValueOnce({
      ...RESP_BASE,
      revisaoMudou: true,
      camposExtraidos: { numero: "999" },
    });

    await rodar("mudei o número para 999");

    expect(h.conversa.dados_coletados.numero).toBe("999");
    expect(h.conversa.dados_bot.revisao_pendente).toBe(false);
    expect(h.conversa.estado).toBe("aguardando_confirmacao_cotacao");
  });

  it("anti-loop: 2º turno sem resposta clara abandona a revisão", async () => {
    h.conversa = novaConversaEmRevisao({ dados_bot: { revisao_pendente: true, revisao_tentativas: 1 } });
    h.chamarBia.mockResolvedValueOnce({ ...RESP_BASE });

    await rodar("blá blá");

    expect(h.conversa.dados_bot.revisao_pendente).toBe(false);
  });

  it("cliente novo (sem flag) não entra em revisão", async () => {
    h.conversa = {
      id: "conv1",
      cliente_id: "cli1",
      canal_id: "canal1",
      estado: "bot_ativo",
      categoria: "seguro_novo",
      dados_coletados: {},
      dados_bot: {},
      operador_id: null,
    };
    h.chamarBia.mockResolvedValueOnce({ ...RESP_BASE });

    await rodar("oi");

    expect(h.chamarBia.mock.calls[0]![0].permitirRevisao).toBe(false);
  });
});
