/**
 * Resolver LLM de UM seletor de portal (só em miss de regra ATIVA).
 *
 * Espelha field-resolver.llm: em vez de inventar um seletor (alucinação), o LLM
 * ESCOLHE entre CANDIDATOS reais coletados da página (forced tool use com enum de
 * índices). O índice -1 = "nenhum serve". O chamador valida o seletor na página
 * antes de usar. 1 chamada, max_tokens baixo. Erro/refusal/sentinela → null.
 */
import { getEnv } from "../../../config/env";
import { logger } from "../../../utils/logger";
import { getMapperResolverClient } from "../../claude/mapper-resolver.client";

export interface CandidatoElemento {
  /** Seletor estável já calculado para este elemento (id/name/role/nth). */
  seletor: string;
  /** Descrição curta (tag + texto + atributos) p/ o LLM decidir. NUNCA PII. */
  descricao: string;
}

export interface EscolhaSeletor {
  seletor: string | null;
  confianca: number;
}

const SYSTEM =
  "Você automatiza portais de seguradora. Dada uma AÇÃO e uma lista de elementos candidatos da página, escolha o índice do elemento que cumpre a ação. Responda SOMENTE chamando a ferramenta escolher_elemento. Se nenhum candidato servir, use idx = -1. NUNCA invente índices fora da lista.";

export async function escolherSeletorComLLM(input: {
  acaoDescricao: string;
  candidatos: CandidatoElemento[];
}): Promise<EscolhaSeletor> {
  if (input.candidatos.length === 0) return { seletor: null, confianca: 0 };

  const env = getEnv();
  const client = getMapperResolverClient();
  const indices = input.candidatos.map((_, i) => i);
  const enumIdx = [...indices, -1];

  const tool = {
    name: "escolher_elemento",
    description: "Escolhe o índice do elemento que cumpre a ação (ou -1).",
    input_schema: {
      type: "object" as const,
      properties: {
        idx: {
          type: "integer" as const,
          enum: enumIdx,
          description: "Índice do candidato que cumpre a ação, ou -1 se nenhum.",
        },
        confianca: { type: "number" as const, description: "Confiança de 0 a 1." },
      },
      required: ["idx", "confianca"],
    },
  };

  const lista = input.candidatos.map((c, i) => `[${i}] ${c.descricao}`).join("\n");
  const promptUsuario = [
    `Ação: ${input.acaoDescricao}`,
    "",
    "Elementos candidatos da página:",
    lista,
  ].join("\n");

  try {
    const resp = await client.messages.create({
      model: env.MAPPER_LLM_MODEL || env.BIA_MODEL,
      max_tokens: env.MAPPER_LLM_MAX_TOKENS,
      system: [{ type: "text" as const, text: SYSTEM, cache_control: { type: "ephemeral" as const } }],
      tools: [tool],
      tool_choice: { type: "tool", name: "escolher_elemento" },
      messages: [{ role: "user", content: promptUsuario }],
    });
    if (resp.stop_reason === "refusal") return { seletor: null, confianca: 0 };
    const bloco = resp.content.find(
      (b): b is Extract<typeof b, { type: "tool_use" }> =>
        b.type === "tool_use" && b.name === "escolher_elemento",
    );
    if (!bloco) return { seletor: null, confianca: 0 };
    const args = bloco.input as { idx?: unknown; confianca?: unknown } | undefined;
    const idx = typeof args?.idx === "number" ? args.idx : -1;
    const confianca = typeof args?.confianca === "number" ? args.confianca : 0;
    // Pós-validação: índice DENTRO da lista (defesa contra alucinação).
    if (!Number.isInteger(idx) || idx < 0 || idx >= input.candidatos.length) {
      return { seletor: null, confianca: 0 };
    }
    return { seletor: input.candidatos[idx]!.seletor, confianca };
  } catch (e) {
    logger.warn("[portal.resolver] exceção na chamada; seletor não resolvido", {
      erro: (e as Error).message,
    });
    return { seletor: null, confianca: 0 };
  }
}
