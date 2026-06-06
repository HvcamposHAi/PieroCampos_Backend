/**
 * CONTRATO da API OFICIAL da Segfy (api.segfy.com / api-v2.segfy.com).
 *
 * ⚠️ DESENHO, não implementação. A Segfy ANUNCIA uma API oficial para integração
 * CRM/ERP, mas NÃO há documentação pública — exige contato comercial
 * (sac@segfy.com / contato@segfy.com / WhatsApp 41 99569-2284) e credenciais que
 * ainda não temos. Estes schemas refletem a EXPECTATIVA do que a API deve
 * devolver e existem para PARSE DEFENSIVO + encaixe futuro sem refactor. Calibre-os
 * contra a documentação real (Swagger/OpenAPI) ANTES de implementar o provider.
 *
 * Princípio de encaixe: a SAÍDA de cotação reusa `ResultadoCotacaoItem` (o mesmo
 * tipo que `cotarAuto` produz e que `QuoteResult.maisBarata` consome), e a ENTRADA
 * reusa `PayloadCotacaoAuto`. Assim um futuro provider oficial pluga no
 * `quote/registry.ts` sem tocar no orquestrador, no bot nem na porta QuoteProvider.
 */
import { z } from "zod";
import { PayloadCotacaoAutoSchema, ResultadoCotacaoItemSchema } from "../segfy.types";

// ── Autenticação oficial ─────────────────────────────────────────────────────
// Credenciais de API comercial (client_id/secret ou api key), NÃO o e-mail/senha
// do portal. A forma exata depende do que a Segfy fornecer (OAuth2? API key?).

export const SegfyOficialAuthInputSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scope: z.string().optional(),
});
export type SegfyOficialAuthInput = z.infer<typeof SegfyOficialAuthInputSchema>;

export const SegfyOficialTokenSchema = z
  .object({
    accessToken: z.string().min(1),
    tokenType: z.string().default("Bearer"),
    expiresInSec: z.number().int().positive().optional(),
  })
  .passthrough();
export type SegfyOficialToken = z.infer<typeof SegfyOficialTokenSchema>;

// ── Cotação Auto ─────────────────────────────────────────────────────────────
// Entrada REUSA o domínio existente (não reinventar). Saída por item REUSA
// ResultadoCotacaoItem — encaixe direto no QuoteResult.

export const SegfyOficialCotacaoInputSchema = PayloadCotacaoAutoSchema;
export type SegfyOficialCotacaoInput = z.infer<typeof SegfyOficialCotacaoInputSchema>;

export const SegfyOficialCotacaoResultSchema = z
  .object({
    cotacaoOficialId: z.string().min(1),
    resultados: z.array(ResultadoCotacaoItemSchema).default([]),
  })
  .passthrough();
export type SegfyOficialCotacaoResult = z.infer<typeof SegfyOficialCotacaoResultSchema>;

// ── Apólice e comissão (roadmap — o módulo HTTP atual não cobre estes) ─────────

export const SegfyOficialApoliceSchema = z
  .object({
    apoliceId: z.string().min(1),
    numero: z.string().optional(),
    seguradora: z.string(),
    premioTotal: z.number().nonnegative(),
    vigenciaInicio: z.string().optional(),
    vigenciaFim: z.string().optional(),
    status: z.string().default("emitida"),
  })
  .passthrough();
export type SegfyOficialApolice = z.infer<typeof SegfyOficialApoliceSchema>;

export const SegfyOficialComissaoSchema = z
  .object({
    apoliceId: z.string().min(1),
    percentual: z.number(),
    valor: z.number().nonnegative(),
    competencia: z.string().optional(),
  })
  .passthrough();
export type SegfyOficialComissao = z.infer<typeof SegfyOficialComissaoSchema>;
