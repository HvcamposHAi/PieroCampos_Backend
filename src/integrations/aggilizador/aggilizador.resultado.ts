/**
 * Parsing dos RESULTADOS do polling do Aggilizador → `ResultadoCotacaoItem`
 * (contrato único de comparativo, idêntico ao Segfy). PURO e testável.
 *
 * Diferente do Segfy (resultados por WebSocket), o Aggilizador entrega por
 * POLLING HTTP: GET /calculo/cotacao/calculos/{idIntegracao}/{versao} devolve um
 * ARRAY com uma entrada por seguradora, cada uma com `retorno`/`retornoErro`/
 * `premio`. Enquanto processa, `retorno:false` e `premio:0`.
 *
 * ⚠️ VALIDAR-LIVE: a captura disponível pegou a cotação AINDA processando, então
 * a forma do item com `retorno:true` (parcelas e coberturas detalhadas) não está
 * 100% confirmada. O schema usa `.passthrough()` e a extração de parcelas é
 * defensiva: quando a forma final chegar (HAR de cotação concluída), basta
 * ajustar `extrairParcelamento` — o resto do pipeline não muda.
 */
import { z } from "zod";
import type { ResultadoCotacaoItem } from "../segfy/segfy.types";

/** Schema defensivo do item de polling (tolera campos extras). */
export const PollingItemSchema = z
  .object({
    seguradoraTxt: z.string().optional(),
    retorno: z.boolean().optional(),
    retornoErro: z.boolean().optional(),
    premio: z.number().nullable().optional(),
    tempoResposta: z.number().nullable().optional(),
    mensagem: z.string().nullable().optional(),
    parcelamento: z.unknown().optional(),
  })
  .passthrough();

/** true se TODAS as seguradoras já retornaram (sucesso ou erro) — encerra o polling. */
export function todasRetornaram(itens: unknown[]): boolean {
  if (itens.length === 0) return false;
  return itens.every((raw) => {
    const r = PollingItemSchema.safeParse(raw);
    if (!r.success) return false;
    return r.data.retorno === true || r.data.retornoErro === true;
  });
}

/**
 * Extrai (parcelas, valor_parcela) de uma tabela de parcelamento, se houver.
 * ⚠️ VALIDAR-LIVE: a forma exata vem na captura concluída. Aceita defensivamente
 * { "10": 401.35, ... } OU [{ parcelas, valor }]; senão devolve 1x do prêmio.
 */
function extrairParcelamento(parcelamento: unknown, premio: number): { parcelas: number; valor_parcela: number } {
  // Forma A: objeto { "1": v1, ..., "10": v10 } (mapa nº-parcelas → valor).
  if (parcelamento && typeof parcelamento === "object" && !Array.isArray(parcelamento)) {
    const tabela = parcelamento as Record<string, unknown>;
    let parcelas = 1;
    for (const k of Object.keys(tabela)) {
      const n = Number(k);
      if (Number.isInteger(n) && n > parcelas && typeof tabela[k] === "number") parcelas = n;
    }
    const valor = tabela[String(parcelas)];
    if (typeof valor === "number") return { parcelas, valor_parcela: valor };
  }
  // Forma B: array [{ parcelas, valor }].
  if (Array.isArray(parcelamento) && parcelamento.length > 0) {
    const melhor = parcelamento
      .map((p) => p as { parcelas?: number; valor?: number })
      .filter((p) => typeof p.parcelas === "number" && typeof p.valor === "number")
      .sort((a, b) => (b.parcelas ?? 0) - (a.parcelas ?? 0))[0];
    if (melhor) return { parcelas: melhor.parcelas ?? 1, valor_parcela: melhor.valor ?? 0 };
  }
  // Fallback: à vista (1x do prêmio).
  return { parcelas: 1, valor_parcela: premio };
}

/** Limpa HTML/entidades de uma mensagem e corta p/ exibição curta. */
function limparMensagem(msg?: string | null): string | undefined {
  if (!msg) return undefined;
  const t = msg
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t ? t.slice(0, 180) : undefined;
}

/**
 * Converte um item de polling no item de comparativo do bot. PURO.
 * `cotado` = retornou com prêmio > 0; `recusado`/`processando` caso contrário.
 */
export function mapearResultadoAggilizador(raw: unknown): ResultadoCotacaoItem {
  const d = PollingItemSchema.parse(raw);
  const premioNum = typeof d.premio === "number" && Number.isFinite(d.premio) ? d.premio : 0;
  const erro = d.retornoErro === true;
  const respondeu = d.retorno === true;
  const cotado = respondeu && !erro && premioNum > 0;
  const { parcelas, valor_parcela } = extrairParcelamento(d.parcelamento, premioNum);
  return {
    seguradora: d.seguradoraTxt ?? "Seguradora",
    premio_total: premioNum,
    parcelas,
    valor_parcela,
    coberturas_resumo: "",
    status: cotado ? "cotado" : erro ? "recusado" : respondeu ? "recusado" : "processando",
    motivo: cotado ? undefined : limparMensagem(d.mensagem),
  };
}
