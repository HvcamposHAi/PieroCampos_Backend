/**
 * Registro de providers por RAMO. Ponto único onde se decide "quem cota o quê".
 * Adicionar um sistema novo = registrar aqui (e implementar a porta); o bot e o
 * orquestrador não mudam.
 */
import type { Ramo } from "../../lib/roteiros";
import { normalizarRamo } from "../../lib/roteiros";
import { lerSistemaCotacao } from "../../services/segfy-credenciais.service";
import type { QuoteProvider } from "./quote-provider.port";
import { segfyAutoProvider } from "./segfy-auto.provider";
import { aggilizadorAutoProvider } from "./aggilizador-auto.provider";
import { naoAutomatizadoProvider } from "./nao-automatizado.provider";

const REGISTRO: Record<Ramo, QuoteProvider> = {
  auto: segfyAutoProvider,
  vida: naoAutomatizadoProvider,
  residencial: naoAutomatizadoProvider,
  empresarial: naoAutomatizadoProvider,
  saude: naoAutomatizadoProvider,
};

/**
 * Provider AUTOMATIZADO por SISTEMA de cotação (multi-tenant: cada corretora
 * escolhe o seu em `segfy_credenciais.sistema`). Vale só onde o ramo já tem um
 * provider automatizado (hoje 'auto'); ramos não-auto ignoram o sistema (sempre
 * naoAutomatizado). Sistema desconhecido/ausente → Segfy (default seguro).
 */
const AUTO_POR_SISTEMA: Record<string, QuoteProvider> = {
  segfy: segfyAutoProvider,
  aggilizador: aggilizadorAutoProvider,
};

/**
 * Provider do ramo (regra por-RAMO, pura/síncrona). `normalizarRamo` colapsa
 * null/undefined/desconhecido em 'auto' (retrocompat: conversa antiga sem ramo é
 * auto), então o fallback `?? naoAutomatizadoProvider` é só uma rede — REGISTRO
 * cobre todos os ramos. NÃO consulta a corretora — ver `resolveProvider`.
 */
export function getProvider(ramo: Ramo | string | null | undefined): QuoteProvider {
  const r = normalizarRamo(ramo as string | null | undefined);
  return REGISTRO[r] ?? naoAutomatizadoProvider;
}

/**
 * Provider EFETIVO da corretora para o ramo (eixo duplo: o ramo decide
 * automatizado×não; o sistema decide QUAL automatizado). Async porque lê o
 * sistema da corretora. FAIL-OPEN: `lerSistemaCotacao` já devolve 'segfy' em
 * qualquer falha, e `?? segfyAutoProvider` cobre sistema fora do mapa — então
 * uma corretora Segfy NUNCA muda de comportamento. Único call-site: o
 * orquestrador `cotacao.service.dispararCotacao`.
 */
export async function resolveProvider(
  corretoraId: string | undefined,
  ramo: Ramo | string | null | undefined,
): Promise<QuoteProvider> {
  const base = getProvider(ramo);
  if (!base.automatizado) return base; // ramo não-auto: sistema é irrelevante
  const sistema = await lerSistemaCotacao(corretoraId);
  return AUTO_POR_SISTEMA[sistema] ?? segfyAutoProvider;
}
