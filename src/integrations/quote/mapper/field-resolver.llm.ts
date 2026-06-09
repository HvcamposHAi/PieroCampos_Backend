/**
 * Resolver LLM de UM campo (só em miss de regra/sinônimo).
 *
 * Dado o schema do campo (descrição + opções válidas) e o valor bruto coletado,
 * o Claude escolhe o `value` EXATO do provedor — via forced tool use com enum
 * restrito (não pode inventar valor). 1 chamada, max_tokens baixo, schema do
 * campo em bloco cacheável. PII redigida antes do prompt. Erro/timeout/sentinela
 * → { valor: null } (o mapper cai no default/omite o campo, nunca lança).
 */
import { getEnv } from "../../../config/env";
import { logger } from "../../../utils/logger";
import { redigirPII } from "../../../services/aprendizado.service";
import { getMapperResolverClient } from "../../claude/mapper-resolver.client";
import type { ProviderField } from "./provider-schema.types";

/** Sentinela de "não consegui inferir" (o enum do tool a inclui). */
const DESCONHECIDO = "DESCONHECIDO";

export interface ResolverInput {
  campo: ProviderField;
  /** Valor bruto (normalizado) que o cliente forneceu para o campo. */
  valorBruto: string | null;
  /** dados_coletados inteiro (campos derivados precisam de contexto). */
  dados: Record<string, unknown>;
}

export interface ResolverOutput {
  /** value do provedor, ou null = não inferível. */
  valor: string | null;
  confianca: number;
}

const SYSTEM = `Você mapeia a resposta livre de um cliente para UM valor exato exigido por uma seguradora numa cotação de seguro. Responda SOMENTE chamando a ferramenta resolver_campo. Escolha o value que melhor corresponde à resposta do cliente. Se nenhuma opção corresponder com segurança, use o value "${DESCONHECIDO}". NUNCA invente valores fora da lista.`;

/** Monta o contexto redigido (sem PII) com as fontes relevantes do campo. */
function contextoRedigido(input: ResolverInput): string {
  const partes: string[] = [];
  for (const fonte of input.campo.fontes) {
    const v = input.dados[fonte];
    if (v != null && v !== "") partes.push(`${fonte}: ${String(v)}`);
  }
  return redigirPII(partes.join("\n"));
}

export async function resolverCampoComLLM(input: ResolverInput): Promise<ResolverOutput> {
  const opcoes = input.campo.opcoes ?? [];
  if (opcoes.length === 0 || input.valorBruto == null) return { valor: null, confianca: 0 };

  const env = getEnv();
  const client = getMapperResolverClient();
  const valoresValidos = opcoes.map((o) => o.value);
  const enumValores = [...valoresValidos, DESCONHECIDO];

  const tool = {
    name: "resolver_campo",
    description: `Escolhe o value do provedor para o campo "${input.campo.chaveAlvo}".`,
    input_schema: {
      type: "object" as const,
      properties: {
        value: {
          type: "string" as const,
          enum: enumValores,
          description: "O value exato do provedor que corresponde à resposta do cliente.",
        },
        confianca: {
          type: "number" as const,
          description: "Confiança de 0 a 1 na escolha.",
        },
      },
      required: ["value", "confianca"],
    },
  };

  const linhasOpcoes = opcoes
    .map((o) => `- ${o.value}: ${o.descricao}${o.sinonimos.length ? ` (ex.: ${o.sinonimos.join(", ")})` : ""}`)
    .join("\n");
  const promptUsuario = [
    `Campo: ${input.campo.chaveAlvo} — ${input.campo.descricao}`,
    "",
    "Opções válidas (value: descrição):",
    linhasOpcoes,
    "",
    `Resposta do cliente: ${redigirPII(input.valorBruto)}`,
    "",
    "Contexto adicional do cadastro:",
    contextoRedigido(input) || "(nenhum)",
  ].join("\n");

  try {
    const resp = await client.messages.create({
      model: env.MAPPER_LLM_MODEL || env.BIA_MODEL,
      max_tokens: env.MAPPER_LLM_MAX_TOKENS,
      system: [
        // Descrição do campo é byte-estável por versão → cacheável entre chamadas.
        { type: "text" as const, text: SYSTEM, cache_control: { type: "ephemeral" as const } },
      ],
      tools: [tool],
      tool_choice: { type: "tool", name: "resolver_campo" },
      messages: [{ role: "user", content: promptUsuario }],
    });

    if (resp.stop_reason === "refusal") return { valor: null, confianca: 0 };
    const bloco = resp.content.find(
      (b): b is Extract<typeof b, { type: "tool_use" }> =>
        b.type === "tool_use" && b.name === "resolver_campo",
    );
    if (!bloco) return { valor: null, confianca: 0 };
    const args = bloco.input as { value?: unknown; confianca?: unknown } | undefined;
    const value = typeof args?.value === "string" ? args.value : DESCONHECIDO;
    const confianca = typeof args?.confianca === "number" ? args.confianca : 0;
    // Pós-validação: só aceita value DENTRO das opções (defesa contra alucinação).
    if (value === DESCONHECIDO || !valoresValidos.includes(value)) {
      return { valor: null, confianca: 0 };
    }
    return { valor: value, confianca };
  } catch (e) {
    logger.warn("[mapper.resolver] exceção na chamada; campo não resolvido", {
      chave: input.campo.chaveAlvo,
      erro: (e as Error).message,
    });
    return { valor: null, confianca: 0 };
  }
}
