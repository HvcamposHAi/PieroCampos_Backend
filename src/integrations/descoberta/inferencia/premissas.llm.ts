/**
 * Aumento por LLM das premissas/segurança: o Claude analisa o HAR resumido (já
 * redigido) + endpoints + análise determinística e propõe premissas adicionais
 * (ex.: enums, formatos, rate-limit textual) com confiança. ISOLADO do hot-path;
 * roda só na descoberta (no daemon). FAIL-SAFE: qualquer erro → [] (o contrato
 * fica com as premissas determinísticas). Injetável p/ teste (sem rede).
 */
import Anthropic from "@anthropic-ai/sdk";
import { getEnv } from "../../../config/env";
import { logger } from "../../../utils/logger";
import type { AnaliseSeguranca, EndpointDescoberto, HarResumo, Premissa } from "../descoberta.types";

export interface InferirPremissasInput {
  sistema: string;
  ramo: string;
  har: HarResumo;
  endpoints: EndpointDescoberto[];
  seguranca: AnaliseSeguranca;
}

/** Assinatura mínima do cliente (só o que usamos) — facilita o mock. */
export interface ClienteLLM {
  messages: {
    create(args: unknown): Promise<{ content: Array<{ type: string; name?: string; input?: unknown }> }>;
  };
}

export interface PremissasLLMDeps {
  cliente?: ClienteLLM;
  modelo?: string;
  maxTokens?: number;
}

const TOOL = {
  name: "registrar_premissas",
  description: "Registra as premissas/pré-condições adicionais inferidas da página.",
  input_schema: {
    type: "object",
    properties: {
      premissas: {
        type: "array",
        items: {
          type: "object",
          properties: {
            chave: { type: "string" },
            valor: { type: ["string", "number", "boolean"] },
            evidencia: { type: "string" },
            confianca: { type: "number" },
          },
          required: ["chave", "valor", "confianca"],
        },
      },
    },
    required: ["premissas"],
  },
} as const;

function clientePadrao(): ClienteLLM {
  const env = getEnv();
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) as unknown as ClienteLLM;
}

export async function inferirPremissasLLM(input: InferirPremissasInput, deps: PremissasLLMDeps = {}): Promise<Premissa[]> {
  // Só precisa do env quando algo NÃO foi injetado (cliente real / modelo / tokens).
  const precisaEnv = !deps.cliente || !deps.modelo || deps.maxTokens === undefined;
  let env: ReturnType<typeof getEnv> | null = null;
  if (precisaEnv) {
    try {
      env = getEnv();
    } catch {
      return [];
    }
    if (!env.ANTHROPIC_API_KEY) return [];
  }

  const cliente = deps.cliente ?? clientePadrao();
  const modelo = deps.modelo ?? (env!.DESCOBERTA_LLM_MODEL || env!.BIA_MODEL);
  const maxTokens = deps.maxTokens ?? env!.DESCOBERTA_LLM_MAX_TOKENS;

  // contexto compacto e SEM PII (o HAR já vem redigido)
  const contexto = {
    sistema: input.sistema,
    ramo: input.ramo,
    seguranca: input.seguranca,
    endpoints: input.endpoints.map((e) => ({ metodo: e.metodo, path: e.pathTemplate, papel: e.papel, campos: e.campos.map((c) => c.nome) })),
  };

  try {
    const resp = await cliente.messages.create({
      model: modelo,
      max_tokens: maxTokens,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      system:
        "Você documenta integrações de seguros. A partir do tráfego REDIGIDO e da análise de segurança, " +
        "liste premissas/pré-condições ADICIONAIS do processo (formatos, enums, campos obrigatórios não óbvios, " +
        "rate-limit, idempotência). NUNCA invente segredos nem PII. Responda só chamando a ferramenta.",
      messages: [{ role: "user", content: JSON.stringify(contexto) }],
    });
    const bloco = resp.content.find((c) => c.type === "tool_use" && c.name === TOOL.name);
    const out = (bloco?.input as { premissas?: Premissa[] } | undefined)?.premissas ?? [];
    return out.filter((p) => p && typeof p.chave === "string").map((p) => ({ ...p, confianca: Math.max(0, Math.min(1, Number(p.confianca) || 0)) }));
  } catch (e) {
    logger.warn("[descoberta] inferirPremissasLLM falhou (FAIL-SAFE → só premissas determinísticas)", {
      erro: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}
