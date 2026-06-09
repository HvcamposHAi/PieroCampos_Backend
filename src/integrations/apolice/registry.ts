/**
 * Registro de providers de EMISSÃO por `grupo_integracao`. Ponto único onde se
 * decide "como emitimos a apólice de cada seguradora". Espelha quote/registry.ts,
 * mas a chave é o grupo da seguradora (não o ramo). Fallback seguro = RPA.
 */
import type { ApoliceProvider, GrupoIntegracao, SeguradoraConfigRef } from "./apolice-provider.port";
import { apiApoliceProvider, rpaApoliceProvider, rpaOtpApoliceProvider } from "./providers";

const REGISTRO: Record<GrupoIntegracao, ApoliceProvider> = {
  A_api: apiApoliceProvider,
  B_rpa: rpaApoliceProvider,
  C_otp: rpaOtpApoliceProvider,
};

export function getApoliceProvider(seg: Pick<SeguradoraConfigRef, "grupoIntegracao">): ApoliceProvider {
  return REGISTRO[seg.grupoIntegracao] ?? rpaApoliceProvider;
}
