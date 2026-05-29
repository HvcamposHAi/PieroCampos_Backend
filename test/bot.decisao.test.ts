/**
 * Testes da decisão "acusar e segurar" (T1–T6 do plano).
 *
 * `decidirAcaoForaDoBot` é pura: não toca Supabase nem Claude, então cobrimos
 * todos os 9 estados do enum + anti-spam + handoff em estado de espera sem mocks.
 */
import { describe, it, expect } from "vitest";
import {
  decidirAcaoForaDoBot,
  AVISO_POS_COLETA,
  ESTADOS_EQUIPE_TRABALHANDO,
} from "../src/services/bot.service";

const TODOS_ESTADOS = [
  "bot_ativo",
  "humano_assumiu",
  "aguardando_cotacao",
  "cotacao_enviada",
  "aceite_registrado",
  "proposta_transmitida",
  "apolice_emitida",
  "bloqueado_vip",
  "encerrado",
] as const;

describe("decidirAcaoForaDoBot", () => {
  it("T1: bot_ativo → responder (fluxo normal, sem regressão)", () => {
    expect(
      decidirAcaoForaDoBot({ estado: "bot_ativo", textoCliente: "Bom dia", ultimaSaida: null }),
    ).toEqual({ tipo: "responder" });
  });

  it("T2: aguardando_cotacao + última saída ≠ aviso → acusar (1ª da rajada)", () => {
    const acao = decidirAcaoForaDoBot({
      estado: "aguardando_cotacao",
      textoCliente: "Bom dia",
      ultimaSaida: "Perfeito, Humberto! Tenho tudo que preciso. ✅",
    });
    expect(acao).toEqual({ tipo: "acusar" });
  });

  it("T3: aguardando_cotacao + última saída == aviso → suprimir (anti-spam)", () => {
    const acao = decidirAcaoForaDoBot({
      estado: "aguardando_cotacao",
      textoCliente: "Bom dia de novo",
      ultimaSaida: AVISO_POS_COLETA,
    });
    expect(acao).toEqual({ tipo: "suprimir" });
  });

  it("T3b: anti-spam tolera espaços/extra whitespace na última saída", () => {
    const acao = decidirAcaoForaDoBot({
      estado: "cotacao_enviada",
      textoCliente: "oi",
      ultimaSaida: `  ${AVISO_POS_COLETA}  `,
    });
    expect(acao.tipo).toBe("suprimir");
  });

  it("T4: estado de espera + gatilho de handoff → handoff (não acusa)", () => {
    const acao = decidirAcaoForaDoBot({
      estado: "aguardando_cotacao",
      textoCliente: "quero falar com um humano por favor",
      ultimaSaida: null,
    });
    expect(acao.tipo).toBe("handoff");
    expect((acao as { gatilho?: string }).gatilho).toBeTruthy();
  });

  it("T4b: gatilho tem prioridade mesmo após já termos acusado", () => {
    const acao = decidirAcaoForaDoBot({
      estado: "aguardando_cotacao",
      textoCliente: "isso é um absurdo, quero cancelar",
      ultimaSaida: AVISO_POS_COLETA, // já acusamos, mas o cliente escalou
    });
    expect(acao.tipo).toBe("handoff");
  });

  it("T5: humano_assumiu → silêncio total (não acusa, não escala)", () => {
    expect(
      decidirAcaoForaDoBot({
        estado: "humano_assumiu",
        textoCliente: "quero falar com humano",
        ultimaSaida: null,
      }),
    ).toEqual({ tipo: "silencio" });
  });

  it("T6: cobertura paramétrica — cada um dos 9 estados cai no bucket certo", () => {
    for (const estado of TODOS_ESTADOS) {
      const acao = decidirAcaoForaDoBot({ estado, textoCliente: "ola", ultimaSaida: null });
      if (estado === "bot_ativo") {
        expect(acao.tipo, estado).toBe("responder");
      } else if (ESTADOS_EQUIPE_TRABALHANDO.has(estado)) {
        // "ola" não é gatilho e ultimaSaida=null → acusar
        expect(acao.tipo, estado).toBe("acusar");
      } else {
        expect(acao.tipo, estado).toBe("silencio");
      }
    }
  });

  it("ESTADOS_EQUIPE_TRABALHANDO é exatamente o conjunto esperado", () => {
    expect([...ESTADOS_EQUIPE_TRABALHANDO].sort()).toEqual(
      ["aceite_registrado", "aguardando_cotacao", "cotacao_enviada", "proposta_transmitida"].sort(),
    );
  });
});
