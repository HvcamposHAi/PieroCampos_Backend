/**
 * Wrapper do SDK Anthropic para o DESTILADOR de ESTILO do operador (offline).
 *
 * Recebe amostras de mensagens reais do operador humano (JÁ redigidas de PII pelo
 * serviço) e destila um PERFIL DE ESTILO: 5–15 linhas de exemplo que capturam o
 * JEITO DE ESCREVER (vocabulário, bordões, ritmo, hábito de emoji) — sem dados de
 * cliente. Saída ESTRUTURADA via forced tool use (o modelo é obrigado a chamar
 * `registrar_estilo`), então a resposta vem como JSON validável.
 *
 * Isolado do claude.client (Bia): este caminho roda só na geração assistida do
 * campo `estilo_amostra` (botão do Admin), NUNCA no hot-path de mensagens. Reusa a
 * mesma ANTHROPIC_API_KEY. Espelha aprendizado.client.ts.
 */
import Anthropic from "@anthropic-ai/sdk";
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";

let cache: Anthropic | null = null;

function getClient(): Anthropic {
  if (cache) return cache;
  const env = getEnv();
  cache = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return cache;
}

const TOOL_REGISTRAR = {
  name: "registrar_estilo",
  description:
    "Registra o perfil de estilo destilado das amostras do operador. Sempre chame esta ferramenta com o resultado da análise.",
  input_schema: {
    type: "object" as const,
    properties: {
      linhas_exemplo: {
        type: "array" as const,
        description:
          "5 a 15 frases CURTAS no jeito de escrever do operador (vocabulário, bordões, ritmo, emoji). " +
          "Cada item é uma frase de exemplo plausível — NÃO copie mensagens reais ao pé da letra nem inclua dados de cliente.",
        items: { type: "string" as const },
      },
    },
    required: ["linhas_exemplo"],
  },
};

const SYSTEM_DESTILADOR = `Você analisa o JEITO DE ESCREVER de um corretor de seguros humano a partir de mensagens reais que ele enviou a clientes. Sua tarefa é destilar um PERFIL DE ESTILO para uma atendente virtual (Bia) imitar a FORMA, nunca o conteúdo.

REGRAS ABSOLUTAS:
- Foque SÓ em ESTILO: vocabulário, bordões/expressões recorrentes, gírias regionais, ritmo/comprimento das frases, pontuação, hábito e tipo de emoji, nível de formalidade.
- NUNCA inclua dados de cliente nem específicos de negócio: nomes próprios, CPF, telefone, e-mail, placa, endereço, valores, nomes de seguradora/produto. Fale do JEITO, não de pessoas ou casos.
- Produza de 5 a 15 frases de exemplo CURTAS, genéricas e reutilizáveis, no estilo do operador (ex.: saudação, confirmação, follow-up) — frases plausíveis, não cópias.
- Se houver pouca amostra, prefira menos linhas (de alta confiança) a inventar um estilo que não está nas amostras.
- Sempre chame a ferramenta registrar_estilo.`;

const MIN_LINHAS = 0;
const MAX_LINHAS = 15;
const MAX_CHARS_LINHA = 240;

function clampLinhas(linhas: unknown): string[] {
  if (!Array.isArray(linhas)) return [];
  const out: string[] = [];
  for (const l of linhas) {
    if (typeof l === "string" && l.trim()) {
      out.push(l.trim().slice(0, MAX_CHARS_LINHA));
    }
    if (out.length >= MAX_LINHAS) break;
  }
  return out;
}

/**
 * Chama o destilador de estilo. Retorna a lista de linhas de exemplo, ou null em
 * qualquer falha (refusal, JSON ausente/inválido, erro de rede) — o chamador
 * trata como "não foi possível gerar" e devolve erro amigável ao Admin.
 */
export async function destilarEstilo(amostras: string[]): Promise<string[] | null> {
  const env = getEnv();
  const client = getClient();
  const model = env.ESTILO_MODEL || env.BIA_MODEL;

  const corpo = amostras
    .map((m, i) => `${i + 1}. ${m}`)
    .join("\n");
  const userMsg = `Amostras de mensagens reais do operador (já anonimizadas):\n\n${corpo}`;

  try {
    const resp = await client.messages.create({
      model,
      max_tokens: env.ESTILO_MAX_TOKENS,
      system: SYSTEM_DESTILADOR,
      tools: [TOOL_REGISTRAR],
      tool_choice: { type: "tool", name: "registrar_estilo" },
      messages: [{ role: "user", content: userMsg }],
    });

    if (resp.stop_reason === "refusal") {
      logger.warn("[estilo.destilar] modelo recusou");
      return null;
    }
    const bloco = resp.content.find(
      (b): b is Extract<typeof b, { type: "tool_use" }> =>
        b.type === "tool_use" && b.name === "registrar_estilo",
    );
    if (!bloco) {
      logger.warn("[estilo.destilar] sem tool_use na resposta");
      return null;
    }
    const args = bloco.input as { linhas_exemplo?: unknown } | undefined;
    const linhas = clampLinhas(args?.linhas_exemplo);
    return linhas.length >= MIN_LINHAS ? linhas : [];
  } catch (e) {
    logger.warn("[estilo.destilar] exceção na chamada", { erro: (e as Error).message });
    return null;
  }
}

/** Para testes unitários. */
export function _resetEstiloClient(): void {
  cache = null;
}
