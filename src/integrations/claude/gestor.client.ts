/**
 * Wrapper do SDK Anthropic para o Copiloto (assistente de BI do gestor).
 *
 * Diferente do `claude.client` da Bia (que extrai campos), aqui o loop de tool_use
 * é AGÊNTICO: cada tool executa uma query de BI e o RESULTADO volta como tool_result
 * para o modelo continuar o raciocínio. O client é GENÉRICO e PURO de banco: quem
 * sabe consultar é o `executarTool` injetado pelo serviço (que carrega o corretoraId
 * da identidade). Isso mantém o isolamento multi-tenant fora do alcance do modelo.
 */
import Anthropic from "@anthropic-ai/sdk";
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import type { MensagemTurno } from "./claude.client";

let cache: Anthropic | null = null;
function getClient(): Anthropic {
  if (cache) return cache;
  cache = new Anthropic({ apiKey: getEnv().ANTHROPIC_API_KEY });
  return cache;
}

export interface CopilotoTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ChamarCopilotoInput {
  systemBase: string;
  systemDinamico: string;
  historico: MensagemTurno[];
  tools: CopilotoTool[];
  /**
   * Executa a tool e devolve o conteúdo textual do tool_result (geralmente JSON
   * stringificado). DEVE ser resiliente: erros viram texto de erro, não throw.
   */
  executarTool: (name: string, input: unknown) => Promise<string>;
  temperature?: number;
}

export interface ResultadoCopiloto {
  texto: string;
  toolsUsadas: string[];
  uso: { input_tokens: number; output_tokens: number };
}

/** Cap de iterações de tool_use (limita custo/runaway). */
const MAX_TOOL_ITERS = 6;

export async function chamarCopiloto(input: ChamarCopilotoInput): Promise<ResultadoCopiloto> {
  const env = getEnv();
  const client = getClient();
  const model = env.GESTOR_MODEL || env.BIA_MODEL;

  const system = [
    { type: "text" as const, text: input.systemBase, cache_control: { type: "ephemeral" as const } },
    { type: "text" as const, text: input.systemDinamico },
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = input.historico.map((m) => ({ role: m.role, content: m.content }));

  let textoAcumulado = "";
  const toolsUsadas: string[] = [];
  let inputTokensTotal = 0;
  let outputTokensTotal = 0;
  let stopReasonFinal: string | null = null;
  let toolIters = 0;
  const t0 = Date.now();

  while (true) {
    const resp = await client.messages.create({
      model,
      max_tokens: env.GESTOR_MAX_TOKENS,
      ...(input.temperature != null ? { temperature: input.temperature } : {}),
      system,
      tools: input.tools,
      messages,
    });
    inputTokensTotal += resp.usage.input_tokens;
    outputTokensTotal += resp.usage.output_tokens;
    stopReasonFinal = resp.stop_reason;

    for (const block of resp.content) {
      if (block.type === "text") textoAcumulado += block.text;
    }

    if (resp.stop_reason !== "tool_use") break;
    if (toolIters >= MAX_TOOL_ITERS) {
      logger.warn("[copiloto] cap de tool_use atingido; saindo do loop", { iters: toolIters });
      break;
    }
    toolIters++;

    const toolUseBlocks = resp.content.filter(
      (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use",
    );
    const conteudoPorId = new Map<string, string>();
    for (const b of toolUseBlocks) {
      toolsUsadas.push(b.name);
      let resultado: string;
      try {
        resultado = await input.executarTool(b.name, b.input);
      } catch (e) {
        resultado = `Erro ao executar ${b.name}: ${(e as Error).message}`;
        logger.warn("[copiloto] executarTool lançou", { tool: b.name, erro: (e as Error).message });
      }
      conteudoPorId.set(b.id, resultado);
    }
    const toolResults = toolUseBlocks.map((b) => ({
      type: "tool_result" as const,
      tool_use_id: b.id,
      content: conteudoPorId.get(b.id) ?? "ok",
    }));
    messages.push({ role: "assistant", content: resp.content });
    messages.push({ role: "user", content: toolResults });
  }

  logger.info("[copiloto] resposta", {
    elapsed_ms: Date.now() - t0,
    stop_reason: stopReasonFinal,
    tool_iters: toolIters,
    tools_usadas: toolsUsadas,
    input_tokens: inputTokensTotal,
    output_tokens: outputTokensTotal,
    texto_len: textoAcumulado.length,
  });

  return {
    texto: textoAcumulado.trim(),
    toolsUsadas,
    uso: { input_tokens: inputTokensTotal, output_tokens: outputTokensTotal },
  };
}

/** Para testes unitários. */
export function _resetCopilotoClient(): void {
  cache = null;
}
