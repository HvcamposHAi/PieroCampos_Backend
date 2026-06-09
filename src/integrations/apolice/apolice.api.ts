/**
 * Caminho de EMISSÃO via API (grupo A_api) — para seguradoras que expõem um
 * endpoint de emissão. Espelha o estilo fino/zod de segfy.apolice.ts. Hoje é um
 * CONTRATO: cada seguradora A_api precisa do seu endpoint/credencial. Enquanto
 * não houver integração HTTP confirmada, devolve `sucesso=false` com erro claro
 * `api_nao_configurada` — e o registry NÃO cai no RPA automaticamente (a escolha
 * de provider é por grupo); a investigação de API é por seguradora (premissa P3).
 */
import type { EmitirApoliceContext, EmitirApoliceResult } from "./apolice-provider.port";
import { logger } from "../../utils/logger";

const RESULTADO_VAZIO: Omit<EmitirApoliceResult, "erro"> = {
  sucesso: false,
  numeroApolice: null,
  inicioVigencia: null,
  fimVigencia: null,
  premioTotal: null,
  premioLiquido: null,
  pdf: null,
};

export async function emitirApoliceViaApi(ctx: EmitirApoliceContext): Promise<EmitirApoliceResult> {
  // Ponto de extensão: quando a seguradora A_api tiver endpoint/contrato, fazer o
  // POST HTTP aqui (zod-validado), retornando os campos da apólice + (se houver)
  // o PDF em bytes. Nunca logar credencial.
  logger.info("[apolice.api] emissão via API ainda não configurada p/ seguradora", {
    seguradora: ctx.seguradora.nomeDisplay,
  });
  return { ...RESULTADO_VAZIO, erro: "api_nao_configurada" };
}

/** Teste de conectividade A_api: ping autenticado (placeholder até haver contrato). */
export async function testarConexaoApi(): Promise<{ ok: boolean; mensagem: string }> {
  return { ok: false, mensagem: "API da seguradora não configurada" };
}
