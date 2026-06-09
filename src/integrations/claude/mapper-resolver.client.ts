/**
 * Wrapper do SDK Anthropic para o RESOLVER de mapeamento (miss do mapper).
 *
 * Isolado do claude.client (Bia) e do aprendizado.client: roda só quando falta
 * uma regra/sinônimo para UM campo, fora do hot-path de mensagens. Reusa a mesma
 * ANTHROPIC_API_KEY. Singleton próprio (1 socket, reuso entre chamadas).
 */
import Anthropic from "@anthropic-ai/sdk";
import { getEnv } from "../../config/env";

let cache: Anthropic | null = null;

export function getMapperResolverClient(): Anthropic {
  if (cache) return cache;
  const env = getEnv();
  cache = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return cache;
}

/** Para testes unitários. */
export function _resetMapperResolverClient(): void {
  cache = null;
}
