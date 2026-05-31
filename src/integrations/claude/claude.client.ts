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

export type Modalidade = "um_a_um" | "formulario";

export interface ResultadoBia {
  texto: string;
  camposExtraidos: Record<string, unknown>;
  /** Preferência registrada via tool escolher_modalidade neste turno, se houve. */
  modalidadeEscolhida: Modalidade | null;
  /** Confirmação da cotação pelo cliente (tool confirmar_cotacao), se houve. */
  confirmarCotacao: boolean | null;
  paradaPorMaxTokens: boolean;
  uso: { input_tokens: number; output_tokens: number };
}

export interface ChamarBiaInput {
  systemBase: string;
  systemDinamico: string;
  historico: MensagemTurno[];
  /** Inclui a tool confirmar_cotacao (fase de confirmação do cliente). */
  permitirConfirmacao?: boolean;
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

const TOOL_ESCOLHER_MODALIDADE = {
  name: "escolher_modalidade",
  description:
    "Registra como o cliente prefere responder o roteiro: 'um_a_um' (você pergunta aqui, uma de cada vez) ou 'formulario' (você envia uma planilha Excel para ele preencher e devolver). Use SOMENTE quando o cliente expressar a preferência.",
  input_schema: {
    type: "object" as const,
    properties: {
      modalidade: {
        type: "string" as const,
        enum: ["um_a_um", "formulario"] as const,
        description: "A preferência escolhida pelo cliente.",
      },
    },
    required: ["modalidade"],
  },
};

const TOOL_CONFIRMAR_COTACAO = {
  name: "confirmar_cotacao",
  description:
    "Registra a decisão do cliente sobre gerar a cotação AGORA. Chame com confirmado=true SOMENTE quando o cliente disser claramente que sim (ex.: 'pode', 'sim', 'manda', 'quero ver'). Se ele pedir para esperar/recusar, confirmado=false.",
  input_schema: {
    type: "object" as const,
    properties: {
      confirmado: {
        type: "boolean" as const,
        description: "true = cliente autorizou gerar a cotação agora; false = ainda não.",
      },
    },
    required: ["confirmado"],
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

/** Cap de iterações no loop de tool_use para limitar custo em runaway. */
const MAX_TOOL_ITERS = 3;

export async function chamarBia(input: ChamarBiaInput): Promise<ResultadoBia> {
  const env = getEnv();
  const client = getClient();

  // System prompt em DOIS blocos: o primeiro (BASE) marcado para cache.
  const system = [
    { type: "text" as const, text: input.systemBase, cache_control: { type: "ephemeral" as const } },
    { type: "text" as const, text: input.systemDinamico },
  ];

  // Histórico mutável: vamos APPEND-ar as respostas com tool_use + tool_result
  // quando Claude parar com stop_reason='tool_use'. A SDK aceita content como
  // array de blocks (necessário para tool_use/tool_result).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = input.historico.map((m) => ({ role: m.role, content: m.content }));

  const tools = input.permitirConfirmacao
    ? [TOOL_ATUALIZAR_DADOS, TOOL_ESCOLHER_MODALIDADE, TOOL_CONFIRMAR_COTACAO]
    : [TOOL_ATUALIZAR_DADOS, TOOL_ESCOLHER_MODALIDADE];

  let textoAcumulado = "";
  const camposExtraidos: Record<string, unknown> = {};
  let modalidadeEscolhida: Modalidade | null = null;
  let confirmarCotacao: boolean | null = null;
  let inputTokensTotal = 0;
  let outputTokensTotal = 0;
  let cacheReadTotal = 0;
  let cacheCreationTotal = 0;
  let stopReasonFinal: string | null = null;
  let toolIters = 0;

  const t0 = Date.now();

  while (true) {
    const resp = await client.messages.create({
      model: env.BIA_MODEL,
      max_tokens: env.BIA_MAX_TOKENS,
      system,
      tools,
      messages,
    });

    inputTokensTotal += resp.usage.input_tokens;
    outputTokensTotal += resp.usage.output_tokens;
    cacheReadTotal +=
      (resp.usage as unknown as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
    cacheCreationTotal +=
      (resp.usage as unknown as { cache_creation_input_tokens?: number })
        .cache_creation_input_tokens ?? 0;
    stopReasonFinal = resp.stop_reason;

    // Acumula texto e captura tool_use desta resposta.
    for (const block of resp.content) {
      if (block.type === "text") {
        textoAcumulado += block.text;
      } else if (block.type === "tool_use" && block.name === "atualizar_dados") {
        const args = block.input as { campos?: Record<string, unknown> } | undefined;
        if (args?.campos && typeof args.campos === "object") {
          const sanitizados = sanitizarCampos(args.campos);
          for (const [k, v] of Object.entries(sanitizados)) camposExtraidos[k] = v;
        }
      } else if (block.type === "tool_use" && block.name === "escolher_modalidade") {
        const args = block.input as { modalidade?: unknown } | undefined;
        if (args?.modalidade === "um_a_um" || args?.modalidade === "formulario") {
          modalidadeEscolhida = args.modalidade;
        }
      } else if (block.type === "tool_use" && block.name === "confirmar_cotacao") {
        const args = block.input as { confirmado?: unknown } | undefined;
        if (typeof args?.confirmado === "boolean") confirmarCotacao = args.confirmado;
      }
    }

    // Sai do loop quando Claude termina com texto (end_turn / max_tokens / stop_sequence).
    if (resp.stop_reason !== "tool_use") break;
    if (toolIters >= MAX_TOOL_ITERS) {
      logger.warn("[claude] cap de tool_use atingido; saindo do loop", { iters: toolIters });
      break;
    }
    toolIters++;

    // Constrói tool_result para cada tool_use da resposta e continua o turno.
    const toolUseBlocks = resp.content.filter(
      (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use",
    );
    const toolResults = toolUseBlocks.map((b) => ({
      type: "tool_result" as const,
      tool_use_id: b.id,
      content: "ok",
    }));
    messages.push({ role: "assistant", content: resp.content });
    messages.push({ role: "user", content: toolResults });
  }

  const elapsedMs = Date.now() - t0;
  const paradaPorMaxTokens = stopReasonFinal === "max_tokens";

  logger.info("[claude] resposta da Bia", {
    elapsed_ms: elapsedMs,
    stop_reason: stopReasonFinal,
    tool_iters: toolIters,
    input_tokens: inputTokensTotal,
    output_tokens: outputTokensTotal,
    cache_read_input_tokens: cacheReadTotal,
    cache_creation_input_tokens: cacheCreationTotal,
    campos_extraidos: Object.keys(camposExtraidos),
    modalidade_escolhida: modalidadeEscolhida,
    texto_len: textoAcumulado.length,
  });

  return {
    texto: textoAcumulado.trim(),
    camposExtraidos,
    modalidadeEscolhida,
    confirmarCotacao,
    paradaPorMaxTokens,
    uso: { input_tokens: inputTokensTotal, output_tokens: outputTokensTotal },
  };
}

/** Para testes unitários. */
export function _resetClaudeClient(): void {
  cache = null;
}
