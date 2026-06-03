/**
 * Wrapper do SDK Anthropic para o DESTILADOR de aprendizado (offline).
 *
 * Recebe transcrições rotuladas (sucesso/falha) de um segmento (categoria) e
 * destila diretrizes acionáveis para a Bia: "padrões que convertem" (potencializar)
 * e "antipadrões a evitar" (não repetir). Saída ESTRUTURADA via forced tool use —
 * o modelo é obrigado a chamar `registrar_aprendizado`, então a resposta vem como
 * JSON validável (sem parsear texto livre, sem prefill, sem budget_tokens).
 *
 * Isolado do claude.client (Bia): este caminho roda só no job de destilação,
 * nunca no hot-path de mensagens. Reusa a mesma ANTHROPIC_API_KEY.
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

export interface DiretrizItem {
  diretriz: string;
  evidencia: string;
}

export interface DiretrizesPlaybook {
  padroes_que_convertem: DiretrizItem[];
  antipadroes_a_evitar: DiretrizItem[];
  resumo: string;
}

export interface DestilarInput {
  /** Rótulo do segmento (categoria ou "geral"). */
  segmento: string;
  /** Transcrições de conversas que deram certo. */
  sucessos: string[];
  /** Transcrições de conversas que falharam, com o motivo do funil. */
  falhas: Array<{ motivo: string; transcricao: string }>;
}

const TOOL_REGISTRAR = {
  name: "registrar_aprendizado",
  description:
    "Registra as diretrizes destiladas das transcrições rotuladas. Sempre chame esta ferramenta com o resultado da análise.",
  input_schema: {
    type: "object" as const,
    properties: {
      padroes_que_convertem: {
        type: "array" as const,
        description: "Padrões de comportamento/fraseado/sequência que levaram a SUCESSO (potencializar).",
        items: {
          type: "object" as const,
          properties: {
            diretriz: { type: "string" as const, description: "Ação concreta para a Bia adotar." },
            evidencia: { type: "string" as const, description: "Por que funcionou (sem dados pessoais)." },
          },
          required: ["diretriz", "evidencia"],
        },
      },
      antipadroes_a_evitar: {
        type: "array" as const,
        description: "Padrões associados a FALHA que a Bia deve evitar (não repetir).",
        items: {
          type: "object" as const,
          properties: {
            diretriz: { type: "string" as const, description: "O que a Bia deve evitar fazer." },
            evidencia: { type: "string" as const, description: "Por que prejudicou (sem dados pessoais)." },
          },
          required: ["diretriz", "evidencia"],
        },
      },
      resumo: { type: "string" as const, description: "Síntese de 1-2 frases para o segmento." },
    },
    required: ["padroes_que_convertem", "antipadroes_a_evitar", "resumo"],
  },
};

const SYSTEM_DESTILADOR = `Você é analista de qualidade de atendimento de uma corretora de seguros. Recebe transcrições de conversas da atendente virtual (Bia) com clientes, JÁ ROTULADAS como SUCESSO (virou apólice/proposta/cotação aceita) ou FALHA (cotação com erro, proposta recusada ou conversa encerrada sem fechamento). Sua tarefa é destilar DIRETRIZES ACIONÁVEIS para a Bia melhorar.

REGRAS ABSOLUTAS:
- Foque em COMPORTAMENTO: fraseado, ordem das perguntas, tom, momento de oferecer cotação, como reagir a objeções. NÃO comente preço, cobertura ou regra de seguradora.
- NUNCA copie dados pessoais (nome, CPF, telefone, e-mail, placa, endereço) para as diretrizes. Fale de padrões, não de pessoas.
- Seja concreto e curto. No máximo 6 padrões e 6 antipadrões.
- Se houver pouca evidência, prefira menos diretrizes (de alta confiança) a inventar.
- Sempre chame a ferramenta registrar_aprendizado.`;

const MAX_ITENS = 6;

function clampItens(itens: unknown): DiretrizItem[] {
  if (!Array.isArray(itens)) return [];
  const out: DiretrizItem[] = [];
  for (const it of itens) {
    const d = (it as { diretriz?: unknown })?.diretriz;
    const e = (it as { evidencia?: unknown })?.evidencia;
    if (typeof d === "string" && d.trim()) {
      out.push({ diretriz: d.trim(), evidencia: typeof e === "string" ? e.trim() : "" });
    }
    if (out.length >= MAX_ITENS) break;
  }
  return out;
}

/**
 * Chama o destilador para um segmento. Retorna as diretrizes ou null em
 * qualquer falha (refusal, JSON ausente/inválido, erro de rede) — o chamador
 * trata como "segmento sem versão" e segue os demais.
 */
export async function destilar(input: DestilarInput): Promise<DiretrizesPlaybook | null> {
  const env = getEnv();
  const client = getClient();

  const partes: string[] = [`SEGMENTO: ${input.segmento}`, ""];
  partes.push(`=== SUCESSO (${input.sucessos.length}) ===`);
  input.sucessos.forEach((t, i) => partes.push(`--- conversa ${i + 1} ---\n${t}`));
  partes.push("");
  partes.push(`=== FALHA (${input.falhas.length}) ===`);
  input.falhas.forEach((f, i) =>
    partes.push(`--- conversa ${i + 1} (motivo: ${f.motivo}) ---\n${f.transcricao}`),
  );

  try {
    const resp = await client.messages.create({
      model: env.APRENDIZADO_MODEL,
      max_tokens: env.APRENDIZADO_MAX_TOKENS,
      system: SYSTEM_DESTILADOR,
      tools: [TOOL_REGISTRAR],
      tool_choice: { type: "tool", name: "registrar_aprendizado" },
      messages: [{ role: "user", content: partes.join("\n") }],
    });

    if (resp.stop_reason === "refusal") {
      logger.warn("[aprendizado.destilar] modelo recusou", { segmento: input.segmento });
      return null;
    }
    const bloco = resp.content.find(
      (b): b is Extract<typeof b, { type: "tool_use" }> =>
        b.type === "tool_use" && b.name === "registrar_aprendizado",
    );
    if (!bloco) {
      logger.warn("[aprendizado.destilar] sem tool_use na resposta", { segmento: input.segmento });
      return null;
    }
    const args = bloco.input as Partial<DiretrizesPlaybook> | undefined;
    return {
      padroes_que_convertem: clampItens(args?.padroes_que_convertem),
      antipadroes_a_evitar: clampItens(args?.antipadroes_a_evitar),
      resumo: typeof args?.resumo === "string" ? args.resumo.trim() : "",
    };
  } catch (e) {
    logger.warn("[aprendizado.destilar] exceção na chamada", {
      segmento: input.segmento,
      erro: (e as Error).message,
    });
    return null;
  }
}

/** Para testes unitários. */
export function _resetAprendizadoClient(): void {
  cache = null;
}
