/**
 * Providers de emissão (adapters FINOS): traduzem o contexto e delegam ao módulo
 * de transporte certo. Sem lógica de negócio aqui — espelha segfy-auto.provider.
 *   - apiApoliceProvider (A_api)   → apolice.api.ts (HTTP)
 *   - rpaApoliceProvider (B_rpa)   → apolice.scraper.ts (Playwright)
 *   - rpaOtpApoliceProvider (C_otp)→ apolice.scraper.ts (Playwright + OTP)
 */
import type { ApoliceProvider, EmitirApoliceContext, EmitirApoliceResult } from "./apolice-provider.port";
import { emitirApolicePortal } from "./apolice.scraper";
import { emitirApoliceViaApi } from "./apolice.api";

export const apiApoliceProvider: ApoliceProvider = {
  nome: "apolice-api",
  grupo: "A_api",
  emitir: (ctx: EmitirApoliceContext): Promise<EmitirApoliceResult> => emitirApoliceViaApi(ctx),
};

export const rpaApoliceProvider: ApoliceProvider = {
  nome: "apolice-rpa",
  grupo: "B_rpa",
  emitir: (ctx: EmitirApoliceContext): Promise<EmitirApoliceResult> => emitirApolicePortal(ctx),
};

export const rpaOtpApoliceProvider: ApoliceProvider = {
  nome: "apolice-rpa-otp",
  grupo: "C_otp",
  // Mesmo fluxo do RPA; o scraper só chama ctx.obterOtp() quando o desafio aparece.
  emitir: (ctx: EmitirApoliceContext): Promise<EmitirApoliceResult> => emitirApolicePortal(ctx),
};
