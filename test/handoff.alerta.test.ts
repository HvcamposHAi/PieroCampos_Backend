/**
 * Alerta de handoff no WhatsApp do operador.
 *  - Funções puras: classificarMotivoHandoff + montarMensagemAlerta.
 *  - Integração em processarMensagem: ao detectar gatilho, dispara
 *    `alertarOperador` EXATAMENTE uma vez e DEPOIS de executar o handoff;
 *    se `alertarOperador` rejeita, processarMensagem ainda resolve (handoff
 *    preservado, alerta é best-effort).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  classificarMotivoHandoff,
  montarMensagemAlerta,
} from "../src/services/handoff.service";

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
            if (table === "canais") return { data: { bot_ativo: true }, error: null };
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
import { MENSAGEM_HANDOFF } from "../src/services/handoff.service";
import { _resetEnvCache } from "../src/config/env";

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
    canal_id: "canal1",
    estado: "bot_ativo",
    categoria: "seguro_novo",
    dados_coletados: {},
    dados_bot: {},
  };
});

interface Resultado {
  textos: string[];
  alertas: Array<{ motivo: string; estadoNoMomento: string }>;
}

async function rodar(
  textoCliente: string,
  opts: { alertaRejeita?: boolean } = {},
): Promise<Resultado> {
  const textos: string[] = [];
  const alertas: Resultado["alertas"] = [];
  await processarMensagem({
    canalId: "canal1",
    conversaId: "conv1",
    jidRemoto: "5541999998888@s.whatsapp.net",
    textoCliente,
    enviar: async (t) => {
      textos.push(t);
    },
    alertarOperador: async (motivo) => {
      // Captura o estado da conversa NO MOMENTO do alerta para provar que o
      // handoff (update estado=humano_assumiu) já ocorreu antes.
      alertas.push({ motivo, estadoNoMomento: h.conversa.estado });
      if (opts.alertaRejeita) throw new Error("baileys_offline");
    },
  });
  return { textos, alertas };
}

describe("classificarMotivoHandoff", () => {
  it("pedido explícito → pedido_humano", () => {
    expect(classificarMotivoHandoff("falar com humano")).toBe("pedido_humano");
    expect(classificarMotivoHandoff("humano")).toBe("pedido_humano");
  });
  it("insatisfação → insatisfacao", () => {
    expect(classificarMotivoHandoff("absurdo")).toBe("insatisfacao");
    expect(classificarMotivoHandoff("cancelamento")).toBe("insatisfacao");
  });
  it("urgência → urgencia", () => {
    expect(classificarMotivoHandoff("sinistro")).toBe("urgencia");
    expect(classificarMotivoHandoff("roubo")).toBe("urgencia");
  });
});

describe("montarMensagemAlerta", () => {
  it("inclui apelido, motivo e telefone (fallback sem nome)", () => {
    const msg = montarMensagemAlerta({
      motivo: "insatisfacao",
      apelidoLinha: "Vendas",
      telefoneCliente: "+5541999998888",
    });
    expect(msg).toContain("Vendas");
    expect(msg).toContain("+5541999998888");
    expect(msg.toLowerCase()).toContain("insatisfa");
  });
  it("usa o nome do cliente quando presente", () => {
    const msg = montarMensagemAlerta({
      motivo: "vip",
      apelidoLinha: "VIP",
      telefoneCliente: "+5541999998888",
      nomeCliente: "Maria",
    });
    expect(msg).toContain("Maria");
    expect(msg).not.toContain("+5541999998888");
  });
});

describe("processarMensagem — alerta no handoff", () => {
  it("rispidez: envia handoff, NÃO chama Claude e alerta uma vez (motivo insatisfacao, após handoff)", async () => {
    const { textos, alertas } = await rodar("isso é um absurdo");
    expect(h.chamarBia).not.toHaveBeenCalled();
    expect(textos).toEqual([MENSAGEM_HANDOFF]);
    expect(alertas).toHaveLength(1);
    expect(alertas[0]!.motivo).toBe("insatisfacao");
    // Prova de ordem: o estado já estava em humano_assumiu quando o alerta rodou.
    expect(alertas[0]!.estadoNoMomento).toBe("humano_assumiu");
  });

  it("pedido de humano: alerta com motivo pedido_humano", async () => {
    const { alertas } = await rodar("quero falar com humano");
    expect(alertas).toHaveLength(1);
    expect(alertas[0]!.motivo).toBe("pedido_humano");
  });

  it("alerta que rejeita NÃO derruba o handoff (resolve sem throw)", async () => {
    const { textos, alertas } = await rodar("sinistro", { alertaRejeita: true });
    expect(textos).toEqual([MENSAGEM_HANDOFF]);
    expect(alertas).toHaveLength(1);
    expect(alertas[0]!.motivo).toBe("urgencia");
    expect(h.conversa.estado).toBe("humano_assumiu");
  });

  it("mensagem normal: sem handoff e sem alerta (Claude responde)", async () => {
    h.chamarBia.mockResolvedValue({
      texto: "Oi! Como posso ajudar?",
      camposExtraidos: {},
      modalidadeEscolhida: null,
      paradaPorMaxTokens: false,
      uso: { input_tokens: 1, output_tokens: 1 },
    });
    const { textos, alertas } = await rodar("oi, quero um seguro");
    expect(alertas).toHaveLength(0);
    expect(h.chamarBia).toHaveBeenCalledTimes(1);
    expect(textos).toHaveLength(1);
    expect(textos[0]).not.toBe(MENSAGEM_HANDOFF);
  });
});
