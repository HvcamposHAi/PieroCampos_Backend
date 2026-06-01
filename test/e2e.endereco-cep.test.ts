/**
 * E2E (fakes; sem rede): coleta de endereço por CEP no fluxo seguro_novo.
 * Verifica que, quando a Bia extrai cep + os campos resolvidos pela consulta
 * (logradouro/bairro/cidade/uf) e o número, o bot.service:
 *   - persiste tudo em conversas.dados_coletados;
 *   - espelha o endereço ESTRUTURADO em clientes.endereco (JSONB).
 * A tool consultar_cep vive dentro do claude.client (mockado aqui) — então
 * simulamos o resultado dela via camposExtraidos retornados por chamarBia.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conversa: null as any,
  chamarBia: vi.fn(),
  dispararCotacaoSegfy: vi.fn(),
  updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
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
            h.updates.push({ table, payload: p });
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
              if (table === "conversas") Object.assign(conversa, payload);
              return { data: null, error: null };
            }
            if (table === "conversas") return { data: { ...conversa }, error: null };
            return { data: null, error: null };
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          then(onF: (v: any) => unknown, onR?: (e: unknown) => unknown) {
            let res: unknown;
            if (op === "update") {
              if (table === "conversas") Object.assign(conversa, payload);
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
  mapearParaCotacao: () => ({ entrada: null, faltando: [] }),
}));

import { processarMensagem } from "../src/services/bot.service";
import { _resetEnvCache } from "../src/config/env";

const RESP = (texto: string, camposExtraidos: Record<string, unknown>) => ({
  texto,
  camposExtraidos,
  modalidadeEscolhida: null,
  confirmarCotacao: null,
  consentimentoLgpd: null,
  paradaPorMaxTokens: false,
  uso: { input_tokens: 1, output_tokens: 1 },
});

beforeEach(() => {
  process.env.BIA_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.WA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "false";
  _resetEnvCache();
  h.chamarBia.mockReset();
  h.dispararCotacaoSegfy.mockReset();
  h.updates = [];
  h.conversa = {
    id: "conv1",
    cliente_id: "cli1",
    estado: "bot_ativo",
    categoria: "seguro_novo",
    dados_coletados: {},
    dados_bot: { modalidade: "um_a_um" },
  };
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

describe("E2E — endereço por CEP (seguro_novo)", () => {
  it("CEP resolvido → espelha clientes.endereco com logradouro/cidade/uf", async () => {
    h.chamarBia.mockResolvedValueOnce(
      RESP("Encontrei a Rua João Alencar Guimarães, Curitiba-PR. Está certo? E qual o número?", {
        cep: "81270320",
        logradouro: "Rua João Alencar Guimarães",
        bairro: "Cidade Industrial",
        cidade: "Curitiba",
        uf: "PR",
      }),
    );

    const textos: string[] = [];
    await mandar("meu cep é 81270-320", textos);

    expect(textos).toHaveLength(1);
    const updEndereco = h.updates.filter((u) => u.table === "clientes" && "endereco" in u.payload);
    expect(updEndereco).toHaveLength(1);
    expect(updEndereco[0]!.payload.endereco).toMatchObject({
      cep: "81270320",
      logradouro: "Rua João Alencar Guimarães",
      cidade: "Curitiba",
      uf: "PR",
    });
  });

  it("turno seguinte com número/complemento → endereço acumula (cep+logradouro do turno anterior)", async () => {
    // Estado após o 1º turno: dados_coletados já tem o CEP resolvido.
    h.conversa.dados_coletados = {
      cep: "81270320",
      logradouro: "Rua João Alencar Guimarães",
      bairro: "Cidade Industrial",
      cidade: "Curitiba",
      uf: "PR",
    };
    h.chamarBia.mockResolvedValueOnce(
      RESP("Anotado!", { numero: "2580", complemento: "sem complemento" }),
    );

    const textos: string[] = [];
    await mandar("número 2580, sem complemento", textos);

    const updEndereco = h.updates.filter((u) => u.table === "clientes" && "endereco" in u.payload);
    expect(updEndereco).toHaveLength(1);
    expect(updEndereco[0]!.payload.endereco).toMatchObject({
      cep: "81270320",
      logradouro: "Rua João Alencar Guimarães",
      numero: "2580",
      complemento: "sem complemento",
      cidade: "Curitiba",
    });
  });
});
