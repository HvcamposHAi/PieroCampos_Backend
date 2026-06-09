/**
 * Parsing dos RESULTADOS do multicálculo (HFy) — ✅ formato CONFIRMADO na captura
 * interativa (30/05/2026). Os resultados NÃO vêm por HTTP: chegam por WebSocket
 * (Socket.IO em wss://socket-io.segfy.com), no evento cujo nome é o `callback`
 * uuid enviado no /calculate. Cada seguradora emite eventos com `action`:
 *   - STEP   → progresso ({ company, message, percentage })
 *   - RESULT → a cotação final da seguradora (premium, installments, coberturas)
 *   - PDF    → link do PDF da cotação
 *
 * Este módulo só faz o PARSE/normalização (puro, testável). A conexão Socket.IO
 * e a coleta dos eventos ficam no cliente de cotação (a ligar — ver endpoints.ts).
 */
import { z } from "zod";
import type { ResultadoCotacaoItem } from "./segfy.types";

/** Envelope de um evento do canal de cotação (`{ action, data }`). */
export const SegfyEventoSchema = z.object({
  action: z.string(),
  data: z.record(z.unknown()).optional(),
});
export type SegfyEvento = z.infer<typeof SegfyEventoSchema>;

/** Subconjunto do `data` de um evento RESULT que realmente usamos. */
export const SegfyResultDataSchema = z
  .object({
    company: z
      .object({ name: z.string().optional(), full_name: z.string().optional() })
      .passthrough()
      .optional(),
    // Seguradoras que recusam/erram retornam premium/franchise = null.
    premium: z.number().nullable().optional(),
    franchise: z.number().nullable().optional(),
    commission: z.number().nullable().optional(),
    status: z.string().optional(),
    messages: z.string().optional(),
    // installments: { "Cartão de Crédito": { "1": 4013.53, ..., "10": 401.35 }, "Boleto": {...} }
    installments: z.record(z.record(z.number())).nullable().optional(),
    company_coverages: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough();
export type SegfyResultData = z.infer<typeof SegfyResultDataSchema>;

/** Status que indicam oferta válida (vira `cotado`); demais = recusado. */
const STATUS_OK = /success|additional_product|done|ok/i;

/** Extrai (parcelas, valor_parcela) priorizando Cartão de Crédito, senão Boleto. */
function melhorParcelamento(
  installments?: Record<string, Record<string, number>>,
): { parcelas: number; valor_parcela: number } {
  if (!installments) return { parcelas: 1, valor_parcela: 0 };
  const tabela = installments["Cartão de Crédito"] ?? installments["Boleto"] ?? Object.values(installments)[0];
  if (!tabela) return { parcelas: 1, valor_parcela: 0 };
  let parcelas = 1;
  for (const k of Object.keys(tabela)) {
    const n = Number(k);
    if (Number.isInteger(n) && n > parcelas) parcelas = n;
  }
  return { parcelas, valor_parcela: tabela[String(parcelas)] ?? 0 };
}

/** Limpa HTML/entidades de uma mensagem do Segfy e corta p/ exibição curta. */
function limparMensagem(msg?: string): string | undefined {
  if (!msg) return undefined;
  const texto = msg
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return texto ? texto.slice(0, 180) : undefined;
}

/** Resumo curto das coberturas para o WhatsApp. */
function resumoCoberturas(cov?: Record<string, unknown>): string {
  if (!cov) return "";
  const tipo = typeof cov.coverage_type === "string" ? cov.coverage_type : "";
  const assist = typeof cov.assistence === "string" ? cov.assistence : "";
  const reserva = typeof cov.rental_car === "string" ? cov.rental_car : "";
  return [tipo && `Cobertura ${tipo}`, assist, reserva].filter(Boolean).join(" · ").slice(0, 160);
}

/**
 * Converte o `data` de um evento RESULT no item de comparativo do bot.
 * Função PURA — coberta por teste.
 */
export function mapearResultadoParaItem(dataBruto: unknown): ResultadoCotacaoItem {
  const d = SegfyResultDataSchema.parse(dataBruto);
  const { parcelas, valor_parcela } = melhorParcelamento(d.installments ?? undefined);
  const premioOk = typeof d.premium === "number" && d.premium > 0;
  const statusOk = premioOk && (!d.status || STATUS_OK.test(d.status));
  return {
    seguradora: d.company?.full_name ?? d.company?.name ?? "Seguradora",
    premio_total: d.premium ?? 0,
    parcelas,
    valor_parcela,
    coberturas_resumo: resumoCoberturas(d.company_coverages ?? undefined),
    status: statusOk ? "cotado" : (d.status ?? "recusado"),
    // Recusadas levam o motivo (limpo) p/ a tela; cotadas não precisam.
    motivo: statusOk ? undefined : limparMensagem(d.messages),
  };
}
