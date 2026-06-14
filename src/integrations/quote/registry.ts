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
import { naoAutomatizadoProvider } from "./nao-automatizado.provider";
import { SISTEMAS } from "./sistemas.catalog";
import { lerAdapterAtivoProvider } from "../descoberta/descoberta.service";

const REGISTRO: Record<Ramo, QuoteProvider> = {
  auto: segfyAutoProvider,
  vida: naoAutomatizadoProvider,
  residencial: naoAutomatizadoProvider,
  empresarial: naoAutomatizadoProvider,
  saude: naoAutomatizadoProvider,
};

/**
 * Provider AUTOMATIZADO por SISTEMA de cotação — DERIVADO do catálogo único
 * (`sistemas.catalog`), sem lista paralela. Multi-tenant: cada corretora escolhe
 * o seu em `segfy_credenciais.sistema`. Vale só onde o ramo já tem provider
 * automatizado (hoje 'auto'); ramos não-auto ignoram o sistema. Sistema
 * desconhecido/ausente → Segfy (default seguro, via fallback em resolveProvider).
 */
const AUTO_POR_SISTEMA: Record<string, QuoteProvider> = Object.fromEntries(
  Object.values(SISTEMAS)
    .filter((s) => s.automatizado)
    .map((s) => [s.id, s.provider]),
);

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
  // ADI: adapter gerado pela descoberta tem prioridade quando aprovado+ativo.
  // FAIL-CLOSED: gated por env + toggle DB; null em qualquer falha/flag-off →
  // segue no caminho legado byte-a-byte (Segfy/Aggilizador). Ver descoberta.service.
  const adapter = await lerAdapterAtivoProvider(corretoraId, sistema, normalizarRamo(ramo));
  if (adapter) return adapter;
  return AUTO_POR_SISTEMA[sistema] ?? segfyAutoProvider;
}
