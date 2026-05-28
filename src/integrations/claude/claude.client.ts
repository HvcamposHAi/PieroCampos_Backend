/**
 * Wrapper do SDK Anthropic para o agente Bia.
 *
 * Responsabilidades:
 *   - Singleton do client (1 instância, reuso de socket)
 *   - Concatenar system prompt BASE (cacheado) + DINÂMICO (varia por turno)
 *   - Tool `atualizar_dados` para extração estruturada de campos
 *   - Whitelist de chaves do tool_input contra `roteiros.CHAVES_VALIDAS`
 *   - Logger sem vazar API key nem prompt completo
 *
 * Não trata persistência nem RAG — orquestração fica em bot.service.
 */
import Anthropic from "@anthropic-ai/sdk";
import { getEnv } from "../../config/env";
import { CHAVES_VALIDAS } from "../../lib/roteiros";
import { logger } from "../../utils/logger";

let cache: Anthropic | null = null;

function getClient(): Anthropic {
  if (cache) return cache;
  const env = getEnv();
  cache = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return cache;
}

export interface MensagemTurno {
  role: "user" | "assistant";
  content: string;
}

export interface ResultadoBia {
  texto: string;
  camposExtraidos: Record<string, unknown>;
  paradaPorMaxTokens: boolean;
  uso: { input_tokens: number; output_tokens: number };
}

export interface ChamarBiaInput {
  systemBase: string;
  systemDinamico: string;
  historico: MensagemTurno[];
}

const TOOL_ATUALIZAR_DADOS = {
  name: "atualizar_dados",
  description:
    "Registra campos extraídos da mensagem do cliente. Use APENAS as chaves listadas no roteiro do prompt do sistema. Não invente chaves novas.",
  input_schema: {
    type: "object" as const,
    properties: {
      campos: {
        type: "object" as const,
        description:
          "Mapa de chave→valor. Chaves devem estar entre as do roteiro (segurado, email, etc). Valores em string.",
        additionalProperties: { type: "string" as const },
      },
    },
    required: ["campos"],
  },
};

function sanitizarCampos(brutos: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(brutos)) {
    if (!CHAVES_VALIDAS.has(k)) {
      logger.warn("[claude] chave fora do roteiro descartada", { chave: k });
      continue;
    }
    if (v == null || v === "") continue;
    out[k] = typeof v === "string" ? v.trim() : v;
  }
  return out;
}

export async function chamarBia(input: ChamarBiaInput): Promise<ResultadoBia> {
  const env = getEnv();
  const client = getClient();

  // System prompt em DOIS blocos: o primeiro (BASE) marcado para cache.
  const system = [
    { type: "text" as const, text: input.systemBase, cache_control: { type: "ephemeral" as const } },
    { type: "text" as const, text: input.systemDinamico },
  ];

  const t0 = Date.now();
  const resp = await client.messages.create({
    model: env.BIA_MODEL,
    max_tokens: env.BIA_MAX_TOKENS,
    system,
    tools: [TOOL_ATUALIZAR_DADOS],
    messages: input.historico.map((m) => ({ role: m.role, content: m.content })),
  });
  const elapsedMs = Date.now() - t0;

  // Concatena os blocos `text` da resposta e captura tool_use de atualizar_dados.
  let textoAcumulado = "";
  let camposExtraidos: Record<string, unknown> = {};

  for (const block of resp.content) {
    if (block.type === "text") {
      textoAcumulado += block.text;
    } else if (block.type === "tool_use" && block.name === "atualizar_dados") {
      const args = block.input as { campos?: Record<string, unknown> } | undefined;
      if (args?.campos && typeof args.campos === "object") {
        camposExtraidos = sanitizarCampos(args.campos);
      }
    }
  }

  const paradaPorMaxTokens = resp.stop_reason === "max_tokens";

  logger.info("[claude] resposta da Bia", {
    elapsed_ms: elapsedMs,
    stop_reason: resp.stop_reason,
    input_tokens: resp.usage.input_tokens,
    output_tokens: resp.usage.output_tokens,
    cache_read_input_tokens:
      (resp.usage as unknown as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0,
    cache_creation_input_tokens:
      (resp.usage as unknown as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0,
    campos_extraidos: Object.keys(camposExtraidos),
    texto_len: textoAcumulado.length,
  });

  return {
    texto: textoAcumulado.trim(),
    camposExtraidos,
    paradaPorMaxTokens,
    uso: { input_tokens: resp.usage.input_tokens, output_tokens: resp.usage.output_tokens },
  };
}

/** Para testes unitários. */
export function _resetClaudeClient(): void {
  cache = null;
}
