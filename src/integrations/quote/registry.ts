/**
 * Registro de providers por RAMO. Ponto único onde se decide "quem cota o quê".
 * Adicionar um sistema novo = registrar aqui (e implementar a porta); o bot e o
 * orquestrador não mudam.
 */
import type { Ramo } from "../../lib/roteiros";
import { normalizarRamo } from "../../lib/roteiros";
import type { QuoteProvider } from "./quote-provider.port";
import { segfyAutoProvider } from "./segfy-auto.provider";
import { naoAutomatizadoProvider } from "./nao-automatizado.provider";

const REGISTRO: Record<Ramo, QuoteProvider> = {
  auto: segfyAutoProvider,
  vida: naoAutomatizadoProvider,
  residencial: naoAutomatizadoProvider,
  empresarial: naoAutomatizadoProvider,
  saude: naoAutomatizadoProvider,
};

/**
 * Provider do ramo. `normalizarRamo` colapsa null/undefined/desconhecido em
 * 'auto' (retrocompat: conversa antiga sem ramo é auto), então o fallback
 * `?? naoAutomatizadoProvider` é só uma rede — REGISTRO cobre todos os ramos.
 */
export function getProvider(ramo: Ramo | string | null | undefined): QuoteProvider {
  const r = normalizarRamo(ramo as string | null | undefined);
  return REGISTRO[r] ?? naoAutomatizadoProvider;
}
