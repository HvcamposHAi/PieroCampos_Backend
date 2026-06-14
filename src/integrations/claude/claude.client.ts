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
import { consultarCep } from "../../lib/cep";
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
  /** Consentimento LGPD do cliente (tool registrar_consentimento_lgpd), se houve. */
  consentimentoLgpd: boolean | null;
  /**
   * Resposta do cliente na REVISÃO de dados (tool confirmar_revisao): true = algo
   * mudou, false = tudo certo, null = ainda não respondeu claramente.
   */
  revisaoMudou: boolean | null;
  /**
   * Cliente quer cotar OUTRO veículo na mesma conversa (tool cotar_outro_veiculo):
   * true = sinalizou novo carro, null = não pediu. Dispara a coleta incremental
   * (limpa só os campos de veículo, mantém os pessoais).
   */
  cotarOutroVeiculo: boolean | null;
  paradaPorMaxTokens: boolean;
  uso: { input_tokens: number; output_tokens: number };
}

export interface ChamarBiaInput {
  systemBase: string;
  systemDinamico: string;
  historico: MensagemTurno[];
  /** Inclui a tool confirmar_cotacao (fase de confirmação do cliente). */
  permitirConfirmacao?: boolean;
  /** Inclui a tool confirmar_revisao (cliente recorrente revisando os dados). */
  permitirRevisao?: boolean;
  /**
   * Inclui a tool cotar_outro_veiculo (cliente pode pedir, na mesma conversa, a
   * cotação de OUTRO carro). Habilitado após uma cotação / em revisão.
   */
  permitirNovoVeiculo?: boolean;
  /**
   * Bloco 2 (PERSONALIZAÇÃO por canal). Entra entre a BASE e a DINÂMICA e é
   * cacheado por canal. Ausente → comportamento idêntico ao anterior (2 blocos).
   */
  systemPersonalizacao?: string;
  /**
   * Bloco 3 (DIRETRIZES APRENDIDAS — playbook destilado do histórico). Entra
   * entre a PERSONALIZAÇÃO e a DINÂMICA e é cacheado (muda raro: só quando um
   * admin ativa nova versão). Ausente → array idêntico ao anterior (zero efeito).
   */
  systemAprendizado?: string;
  /**
   * Temperatura de amostragem. Só enviada à API quando definida — ausente
   * preserva o default da Anthropic (comportamento atual, sem temperature).
   */
  temperature?: number;
  /**
   * Chaves extras aceitas no tool atualizar_dados além das do roteiro — usado
   * pelas perguntas customizadas (custom_*) da linha. Ausente → só CHAVES_VALIDAS.
   */
  chavesExtras?: string[];
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

const TOOL_CONFIRMAR_REVISAO = {
  name: "confirmar_revisao",
  description:
    "Registra a resposta do cliente recorrente sobre os dados que já temos. Chame com mudou=false quando ele disser que está tudo certo / nada mudou; mudou=true quando algo tiver mudado (e, neste caso, chame TAMBÉM atualizar_dados com as chaves alteradas).",
  input_schema: {
    type: "object" as const,
    properties: {
      mudou: {
        type: "boolean" as const,
        description: "true = algum dado mudou; false = está tudo certo.",
      },
    },
    required: ["mudou"],
  },
};

const TOOL_COTAR_OUTRO_VEICULO = {
  name: "cotar_outro_veiculo",
  description:
    "Use quando o cliente quiser cotar OUTRO veículo na mesma conversa (ex.: 'quero cotar outro carro', 'tenho mais um veículo', informa uma placa diferente). Limpa os dados do carro anterior e mantém os dados pessoais. NÃO use para corrigir um dado do mesmo carro (isso é atualizar_dados).",
  input_schema: {
    type: "object" as const,
    properties: {
      confirmado: {
        type: "boolean" as const,
        description: "true = o cliente quer cotar um novo veículo agora.",
      },
    },
    required: ["confirmado"],
  },
};

const TOOL_CONSULTAR_CEP = {
  name: "consultar_cep",
  description:
    "Consulta um CEP brasileiro e retorna o endereço (logradouro, bairro, cidade, UF). Chame assim que o cliente informar o CEP. Depois MOSTRE o endereço ao cliente e PEÇA CONFIRMAÇÃO antes de prosseguir. Se retornar 'não encontrado', peça o logradouro manualmente.",
  input_schema: {
    type: "object" as const,
    properties: {
      cep: {
        type: "string" as const,
        description: "O CEP informado pelo cliente (com ou sem máscara).",
      },
    },
    required: ["cep"],
  },
};

const TOOL_CONSENTIMENTO_LGPD = {
  name: "registrar_consentimento_lgpd",
  description:
    "Registra o consentimento LGPD do cliente para coletar e usar os dados na cotação. Chame com autorizado=true SOMENTE quando o cliente autorizar claramente (ex.: 'sim', 'autorizo', 'pode usar'). Se ele recusar, autorizado=false.",
  input_schema: {
    type: "object" as const,
    properties: {
      autorizado: {
        type: "boolean" as const,
        description: "true = cliente autorizou o uso dos dados (LGPD); false = recusou.",
      },
    },
    required: ["autorizado"],
  },
};

function sanitizarCampos(
  brutos: Record<string, unknown>,
  whitelist: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(brutos)) {
    if (!whitelist.has(k)) {
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

  // System prompt em blocos: BASE (cacheado) + PERSONALIZAÇÃO opcional por canal
  // (cacheado) + APRENDIZADO opcional (cacheado, muda raro) + DINÂMICO (varia por
  // turno, não cacheado). Sem os blocos opcionais, o array fica byte-idêntico ao
  // histórico de 2 blocos — garantia de zero impacto quando os recursos estão off.
  const system = [
    { type: "text" as const, text: input.systemBase, cache_control: { type: "ephemeral" as const } },
    ...(input.systemPersonalizacao
      ? [
          {
            type: "text" as const,
            text: input.systemPersonalizacao,
            cache_control: { type: "ephemeral" as const },
          },
        ]
      : []),
    ...(input.systemAprendizado
      ? [
          {
            type: "text" as const,
            text: input.systemAprendizado,
            cache_control: { type: "ephemeral" as const },
          },
        ]
      : []),
    { type: "text" as const, text: input.systemDinamico },
  ];

  // Histórico mutável: vamos APPEND-ar as respostas com tool_use + tool_result
  // quando Claude parar com stop_reason='tool_use'. A SDK aceita content como
  // array de blocks (necessário para tool_use/tool_result).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = input.historico.map((m) => ({ role: m.role, content: m.content }));

  const tools = [
    TOOL_ATUALIZAR_DADOS,
    TOOL_ESCOLHER_MODALIDADE,
    TOOL_CONSULTAR_CEP,
    TOOL_CONSENTIMENTO_LGPD,
    ...(input.permitirConfirmacao ? [TOOL_CONFIRMAR_COTACAO] : []),
    ...(input.permitirRevisao ? [TOOL_CONFIRMAR_REVISAO] : []),
    ...(input.permitirNovoVeiculo ? [TOOL_COTAR_OUTRO_VEICULO] : []),
  ];

  // Whitelist do tool atualizar_dados: chaves do roteiro + extras da linha (custom_*).
  const whitelist: ReadonlySet<string> =
    input.chavesExtras && input.chavesExtras.length > 0
      ? new Set([...CHAVES_VALIDAS, ...input.chavesExtras])
      : CHAVES_VALIDAS;

  let textoAcumulado = "";
  const camposExtraidos: Record<string, unknown> = {};
  let modalidadeEscolhida: Modalidade | null = null;
  let confirmarCotacao: boolean | null = null;
  let consentimentoLgpd: boolean | null = null;
  let revisaoMudou: boolean | null = null;
  let cotarOutroVeiculo: boolean | null = null;
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
      ...(input.temperature != null ? { temperature: input.temperature } : {}),
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
          const sanitizados = sanitizarCampos(args.campos, whitelist);
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
      } else if (block.type === "tool_use" && block.name === "registrar_consentimento_lgpd") {
        const args = block.input as { autorizado?: unknown } | undefined;
        if (typeof args?.autorizado === "boolean") consentimentoLgpd = args.autorizado;
      } else if (block.type === "tool_use" && block.name === "confirmar_revisao") {
        const args = block.input as { mudou?: unknown } | undefined;
        if (typeof args?.mudou === "boolean") revisaoMudou = args.mudou;
      } else if (block.type === "tool_use" && block.name === "cotar_outro_veiculo") {
        const args = block.input as { confirmado?: unknown } | undefined;
        if (typeof args?.confirmado === "boolean") cotarOutroVeiculo = args.confirmado;
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
    // consultar_cep: resolve o endereço (ViaCEP/BrasilAPI), grava os campos auto
    // em camposExtraidos (dado confiável do servidor) e devolve o endereço no
    // tool_result para a Bia confirmar com o cliente. Demais tools → "ok".
    const conteudoPorId = new Map<string, string>();
    for (const b of toolUseBlocks) {
      if (b.name !== "consultar_cep") continue;
      const args = b.input as { cep?: unknown } | undefined;
      const cepBruto = typeof args?.cep === "string" ? args.cep : "";
      const endereco = await consultarCep(cepBruto);
      if (endereco) {
        camposExtraidos.cep = endereco.cep;
        if (endereco.logradouro) camposExtraidos.logradouro = endereco.logradouro;
        if (endereco.bairro) camposExtraidos.bairro = endereco.bairro;
        if (endereco.cidade) camposExtraidos.cidade = endereco.cidade;
        if (endereco.uf) camposExtraidos.uf = endereco.uf;
        conteudoPorId.set(b.id, JSON.stringify(endereco));
      } else {
        conteudoPorId.set(
          b.id,
          "CEP não encontrado. Peça ao cliente o logradouro, bairro, cidade e UF manualmente.",
        );
      }
    }
    const toolResults = toolUseBlocks.map((b) => ({
      type: "tool_result" as const,
      tool_use_id: b.id,
      content: conteudoPorId.get(b.id) ?? "ok",
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
    consentimentoLgpd,
    revisaoMudou,
    cotarOutroVeiculo,
    paradaPorMaxTokens,
    uso: { input_tokens: inputTokensTotal, output_tokens: outputTokensTotal },
  };
}

/** Para testes unitários. */
export function _resetClaudeClient(): void {
  cache = null;
}
