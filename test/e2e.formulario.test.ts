/**
 * E2E do round-trip de formulário (com fakes, sem rede):
 *   gate → modalidade=formulario → .xlsx enviado → devolução preenchida →
 *   dados_coletados mesclado → estado=aguardando_cotacao → idempotência.
 *
 * Mocka getSupabaseAdmin (fake stateful), chamarBia e rag.service. SEGFY off.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import ExcelJS from "exceljs";

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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          insert: (p: any) => {
            op = "insert";
            payload = p;
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

import { processarMensagem, processarFormularioRecebido } from "../src/services/bot.service";
import { gerarQuestionarioXlsx, parseQuestionarioXlsx } from "../src/integrations/formulario";
import { _resetEnvCache } from "../src/config/env";

/** Preenche a coluna Resposta (E) de todas as linhas de campo. */
async function preencherTudo(buf: Buffer): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.getWorksheet("Questionário")!;
  ws.eachRow((row, n) => {
    if (n < 2) return;
    row.getCell(5).value = "preenchido";
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

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
    estado: "bot_ativo",
    categoria: "renovacao",
    dados_coletados: {},
    dados_bot: {},
  };
});

describe("E2E formulário (renovacao)", () => {
  it("escolhe formulário → envia xlsx → devolve preenchido → cotação", async () => {
    h.chamarBia.mockResolvedValueOnce({
      texto: "Prefere responder aqui ou por planilha?",
      camposExtraidos: {},
      modalidadeEscolhida: "formulario",
      paradaPorMaxTokens: false,
      uso: { input_tokens: 1, output_tokens: 1 },
    });

    const textos: string[] = [];
    const docs: Array<{ documento: Buffer; fileName: string; mimetype: string }> = [];

    await processarMensagem({
      canalId: "canal1",
      conversaId: "conv1",
      jidRemoto: "5541@s.whatsapp.net",
      textoCliente: "quero renovar meu seguro",
      enviar: async (t) => {
        textos.push(t);
      },
      enviarDocumento: async (d) => {
        docs.push({ documento: d.documento, fileName: d.fileName, mimetype: d.mimetype });
      },
    });

    // Enviou exatamente 1 documento, e é o nosso questionário parseável.
    expect(docs).toHaveLength(1);
    expect(docs[0]!.fileName).toContain("renovacao");
    const parsedEnviado = await parseQuestionarioXlsx(docs[0]!.documento);
    expect(parsedEnviado).not.toBeNull();
    expect(parsedEnviado!.categoria).toBe("renovacao");
    // Estado interno registrado.
    expect(h.conversa.dados_bot.modalidade).toBe("formulario");
    expect(h.conversa.dados_bot.formulario?.enviado_em).toBeTruthy();
    // Gate não coleta: dados_coletados segue vazio e estado segue bot_ativo.
    expect(Object.keys(h.conversa.dados_coletados)).toHaveLength(0);
    expect(h.conversa.estado).toBe("bot_ativo");

    // Cliente devolve a planilha preenchida.
    const filled = await preencherTudo(await gerarQuestionarioXlsx("renovacao"));
    await processarFormularioRecebido({
      canalId: "canal1",
      conversaId: "conv1",
      jidRemoto: "5541@s.whatsapp.net",
      documento: filled,
      enviar: async (t) => {
        textos.push(t);
      },
    });

    expect(h.conversa.dados_coletados.segurado).toBe("preenchido");
    expect(h.conversa.dados_coletados.email).toBe("preenchido");
    expect(h.conversa.estado).toBe("aguardando_cotacao"); // SEGFY off → para aqui
    expect(h.conversa.dados_bot.formulario.recebido_em).toBeTruthy();

    // Reenvio do mesmo arquivo → idempotente (não reprocessa).
    const estadoAntes = h.conversa.estado;
    await processarFormularioRecebido({
      canalId: "canal1",
      conversaId: "conv1",
      jidRemoto: "5541@s.whatsapp.net",
      documento: filled,
      enviar: async (t) => {
        textos.push(t);
      },
    });
    expect(h.conversa.estado).toBe(estadoAntes);
  });

  it("formulário recebido com conversa fora de bot_ativo → só acusa", async () => {
    h.conversa.estado = "humano_assumiu";
    const textos: string[] = [];
    const filled = await preencherTudo(await gerarQuestionarioXlsx("renovacao"));
    await processarFormularioRecebido({
      canalId: "canal1",
      conversaId: "conv1",
      jidRemoto: "5541@s.whatsapp.net",
      documento: filled,
      enviar: async (t) => {
        textos.push(t);
      },
    });
    // Não mexeu nos dados nem no estado; só acusou recebimento.
    expect(h.conversa.estado).toBe("humano_assumiu");
    expect(Object.keys(h.conversa.dados_coletados)).toHaveLength(0);
    expect(textos.join(" ")).toMatch(/corretor/i);
  });
});
