/**
 * Orquestrador do Copiloto (BI 360 no WhatsApp para o GESTOR).
 *
 * Pipeline isolado do bot do cliente:
 *   1. Resolve a identidade pelo NÚMERO (allowlist, fail-closed). Desconhecido →
 *      recusa sem tocar em dado nenhum.
 *   2. Gate por corretora (`gestor_assist_config.ativo`, fail-closed).
 *   3. Persiste o thread em tabelas próprias (gestor_conversas/gestor_mensagens).
 *   4. Roda o loop agêntico do Claude com tools de BI READ-ONLY. O `corretoraId`
 *      é injetado no executor a partir da identidade — o modelo NUNCA escolhe a
 *      corretora (âncora de isolamento multi-tenant).
 *
 * Neste incremento: SÓ TEXTO. PDF de apólice e gráficos são o 2º incremento
 * (as tools nem são oferecidas ao modelo aqui).
 */
import { getEnv } from "../../config/env";
import { jidParaE164 } from "../../integrations/whatsapp/persistence";
import {
  carregarHistoricoGestor,
  obterOuCriarGestorConversa,
  registrarMsgGestor,
} from "../../integrations/whatsapp/gestor-persistence";
import { chamarCopiloto, type CopilotoTool } from "../../integrations/claude/gestor.client";
import { logger } from "../../utils/logger";
import {
  apolicesAVencer,
  apolicesDoCliente,
  buscarClientes,
  funilResumo,
  pdfApolice,
  resumoCarteira,
} from "./gestor-bi.service";
import { gerarGraficoPng, type SpecGrafico } from "./gestor-grafico";
import {
  lerGestorConfig,
  resolverGestorPorTelefone,
  type GestorConfig,
  type GestorIdentidade,
} from "./gestor-identidade.service";

const SYSTEM_BASE = `Você é o **Copiloto**, o assistente de inteligência (BI) da corretora de seguros, falando com o GESTOR/corretor pelo WhatsApp. Sua missão é dar uma visão 360° da carteira: clientes, apólices, vencimentos, prêmio e o funil de cotações/propostas.

REGRAS ABSOLUTAS (nunca quebre):
1. Responda SOMENTE com dados retornados pelas suas ferramentas (tools). NUNCA invente números, nomes, datas ou valores. Se não tem o dado, diga que não encontrou.
2. NUNCA calcule totais "de cabeça": os totais já vêm somados pelas tools. Apenas apresente.
3. Você só enxerga os dados DESTA corretora — as tools já são escopadas. Se pedirem dados de outra corretora ou "de todos os clientes do sistema", explique que só atende a carteira desta corretora.
4. Formato WhatsApp: respostas curtas e escaneáveis. Valores em Real (ex.: R$ 1.234,56). Use listas com poucas linhas. Pode usar emojis com moderação (📄 📊 ⏰).
5. Ao apresentar números de carteira/funil, cite que os dados são do momento da consulta (ex.: "agora há pouco").
6. Para perguntas sobre um cliente específico, primeiro use buscar_cliente para achar o id; se houver mais de um, peça para o gestor escolher antes de detalhar.

Você está a serviço do gestor — seja direto, útil e proativo em sugerir o próximo recorte ("quer que eu liste as que vencem em 15 dias?").`;

// Tools de DADOS (read-only) — sempre disponíveis quando o recurso está ligado.
const TOOLS_DADOS: CopilotoTool[] = [
  {
    name: "buscar_cliente",
    description:
      "Busca clientes da carteira por nome (parcial), CPF ou telefone. Use SEMPRE antes de detalhar um cliente, para obter o id. Retorna uma lista (pode vir mais de um).",
    input_schema: {
      type: "object",
      properties: {
        termo: { type: "string", description: "Nome, CPF ou telefone (ou parte) do cliente." },
      },
      required: ["termo"],
    },
  },
  {
    name: "listar_apolices_cliente",
    description:
      "Lista as apólices de UM cliente (use o id vindo de buscar_cliente). Retorna ramo, seguradora, prêmio, vigência e status (vigente/proxima_vencer/vencida).",
    input_schema: {
      type: "object",
      properties: {
        cliente_id: { type: "string", description: "id do cliente (de buscar_cliente)." },
      },
      required: ["cliente_id"],
    },
  },
  {
    name: "apolices_a_vencer",
    description:
      "Lista as apólices da carteira que vencem nos próximos N dias (default 30), com o nome do cliente. Use para perguntas de renovação/vencimento.",
    input_schema: {
      type: "object",
      properties: {
        dias: { type: "integer", description: "Janela em dias (default 30)." },
      },
    },
  },
  {
    name: "resumo_carteira",
    description:
      "Resumo agregado da carteira: total de apólices, prêmio total, contagem por status de vigência e quebra por ramo e por seguradora (já somados).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "funil",
    description:
      "Resumo do funil comercial: contagem de cotações por status e de propostas por status.",
    input_schema: { type: "object", properties: {} },
  },
];

// Tool de AÇÃO: envia o PDF da apólice (só ofertada quando permite_pdf + callback).
const TOOL_ENVIAR_PDF: CopilotoTool = {
  name: "enviar_pdf_apolice",
  description:
    "Envia ao gestor, pelo WhatsApp, o arquivo PDF de UMA apólice (use o id vindo de listar_apolices_cliente). Só funciona se a apólice tiver PDF arquivado.",
  input_schema: {
    type: "object",
    properties: { apolice_id: { type: "string", description: "id da apólice." } },
    required: ["apolice_id"],
  },
};

// Tool de AÇÃO: gera e envia um gráfico de barras (só com permite_grafico + flag + callback).
const TOOL_GRAFICO: CopilotoTool = {
  name: "gerar_grafico",
  description:
    "Gera um gráfico de barras a partir de dados que VOCÊ já obteve (ex.: prêmio por seguradora vindo de resumo_carteira) e o envia ao gestor como imagem. Forneça título e as barras (rótulo + valor numérico).",
  input_schema: {
    type: "object",
    properties: {
      titulo: { type: "string", description: "Título do gráfico." },
      prefixo_valor: { type: "string", description: "Prefixo dos valores, ex.: 'R$ '. Opcional." },
      barras: {
        type: "array",
        description: "Lista de barras.",
        items: {
          type: "object",
          properties: {
            rotulo: { type: "string" },
            valor: { type: "number" },
          },
          required: ["rotulo", "valor"],
        },
      },
    },
    required: ["titulo", "barras"],
  },
};

/** Contexto de execução das tools: corretoraId TRAVADO + callbacks de envio. */
interface ExecutorCtx {
  corretoraId: string;
  canalId: string;
  jid: string;
  config: GestorConfig;
  gestorConversaId: string;
  enviarDocumento?: (doc: { documento: Buffer; fileName: string; mimetype: string; caption?: string }) => Promise<void>;
  enviarImagem?: (img: { imagem: Buffer; caption?: string }) => Promise<void>;
}

/** Monta a lista de tools efetiva segundo a config e os callbacks disponíveis. */
function montarTools(ctx: ExecutorCtx): CopilotoTool[] {
  const tools = [...TOOLS_DADOS];
  if (ctx.config.permitePdf && ctx.enviarDocumento) tools.push(TOOL_ENVIAR_PDF);
  if (ctx.config.permiteGrafico && ctx.enviarImagem) tools.push(TOOL_GRAFICO);
  return tools;
}

/** Constrói o executor das tools com o corretoraId TRAVADO na identidade. */
function montarExecutor(ctx: ExecutorCtx) {
  return async (name: string, input: unknown): Promise<string> => {
    const args = (input ?? {}) as Record<string, unknown>;
    const { corretoraId } = ctx;
    switch (name) {
      case "buscar_cliente": {
        const termo = String(args.termo ?? "");
        return JSON.stringify(await buscarClientes(corretoraId, termo));
      }
      case "listar_apolices_cliente": {
        const clienteId = String(args.cliente_id ?? "");
        if (!clienteId) return JSON.stringify({ erro: "cliente_id ausente" });
        return JSON.stringify(await apolicesDoCliente(corretoraId, clienteId));
      }
      case "apolices_a_vencer": {
        const dias = Number(args.dias);
        return JSON.stringify(await apolicesAVencer(corretoraId, Number.isFinite(dias) ? dias : 30));
      }
      case "resumo_carteira":
        return JSON.stringify(await resumoCarteira(corretoraId));
      case "funil":
        return JSON.stringify(await funilResumo(corretoraId));
      case "enviar_pdf_apolice": {
        if (!ctx.enviarDocumento) return "Envio de PDF indisponível neste canal.";
        const apoliceId = String(args.apolice_id ?? "");
        const pdf = await pdfApolice(corretoraId, apoliceId);
        if (!pdf) return "Não encontrei um PDF arquivado para essa apólice.";
        await ctx.enviarDocumento({
          documento: pdf.buffer,
          fileName: pdf.fileName,
          mimetype: "application/pdf",
          caption: `Apólice ${pdf.numeroApolice}`,
        });
        await registrarMsgGestor({
          gestorConversaId: ctx.gestorConversaId,
          origem: "assistente",
          corpo: `[PDF enviado: ${pdf.fileName}]`,
          midiaTipo: "document",
          toolsUsadas: ["enviar_pdf_apolice"],
        }).catch(() => {});
        return `PDF da apólice ${pdf.numeroApolice} enviado ao gestor.`;
      }
      case "gerar_grafico": {
        if (!ctx.enviarImagem) return "Gráficos indisponíveis neste canal.";
        const barras = Array.isArray(args.barras)
          ? (args.barras as Array<Record<string, unknown>>)
              .map((b) => ({ rotulo: String(b.rotulo ?? ""), valor: Number(b.valor) }))
              .filter((b) => b.rotulo && Number.isFinite(b.valor))
          : [];
        if (!barras.length) return "Sem dados válidos para o gráfico.";
        const spec: SpecGrafico = {
          titulo: String(args.titulo ?? "Gráfico"),
          barras,
          prefixoValor: args.prefixo_valor ? String(args.prefixo_valor) : undefined,
        };
        const png = await gerarGraficoPng(spec);
        if (!png) return "Não consegui gerar a imagem do gráfico agora; apresente os números em texto.";
        await ctx.enviarImagem({ imagem: png, caption: spec.titulo });
        await registrarMsgGestor({
          gestorConversaId: ctx.gestorConversaId,
          origem: "assistente",
          corpo: `[gráfico enviado: ${spec.titulo}]`,
          midiaTipo: "image",
          toolsUsadas: ["gerar_grafico"],
        }).catch(() => {});
        return `Gráfico "${spec.titulo}" enviado ao gestor.`;
      }
      default:
        return JSON.stringify({ erro: `tool desconhecida: ${name}` });
    }
  };
}

function buildSystemDinamico(identidade: GestorIdentidade, podePdf: boolean, podeGrafico: boolean): string {
  const agora = new Date().toISOString();
  const nome = identidade.nomeExibicao ? ` Você fala com ${identidade.nomeExibicao}.` : "";
  const extras: string[] = [];
  if (podePdf) extras.push("enviar o PDF de uma apólice (enviar_pdf_apolice)");
  if (podeGrafico) extras.push("gerar e enviar gráficos de barras (gerar_grafico)");
  const capExtra = extras.length
    ? ` Você também pode ${extras.join(" e ")}.`
    : " Envio de PDF e gráficos não está disponível neste canal — ofereça os dados em texto se pedirem.";
  return `CONTEXTO DESTE ATENDIMENTO\n- Data/hora atual (UTC): ${agora}.${nome}\n- Recursos: consultas de texto (clientes, apólices, vencimentos, carteira, funil).${capExtra}`;
}

export interface ResultadoGestor {
  atendido: boolean;
  resposta: string | null;
  toolsUsadas: string[];
  motivo?: "desabilitado" | "nao_autorizado" | "corretora_desligada" | "ok" | "erro";
}

/**
 * Processa uma mensagem recebida num canal `tipo='gestor'`. `enviar` despacha o
 * texto ao gestor (sem persistir em `mensagens` do cliente). Retorna o resultado
 * para a rota de teste (/simular) e para os E2E.
 */
export async function processarMensagemGestor(input: {
  canalId: string;
  jidRemoto: string;
  /** Telefone real quando o jid é @lid (best-effort); senão derivado do jid. */
  telefoneReal?: string | null;
  textoGestor: string;
  enviar: (texto: string) => Promise<void>;
  /** Envia um documento (PDF) ao gestor. Ausente → tool de PDF não é oferecida. */
  enviarDocumento?: (doc: { documento: Buffer; fileName: string; mimetype: string; caption?: string }) => Promise<void>;
  /** Envia uma imagem (gráfico) ao gestor. Ausente → tool de gráfico não é oferecida. */
  enviarImagem?: (img: { imagem: Buffer; caption?: string }) => Promise<void>;
}): Promise<ResultadoGestor> {
  const env = getEnv();
  // Defesa em profundidade: mesmo gate do eventHandlers (a rota /simular cai aqui).
  if (!env.GESTOR_ASSIST_ENABLED) {
    return { atendido: false, resposta: null, toolsUsadas: [], motivo: "desabilitado" };
  }

  const telefone = input.telefoneReal ?? jidParaE164(input.jidRemoto);
  const identidade = await resolverGestorPorTelefone(telefone);
  if (!identidade) {
    const recusa =
      "Olá! Este canal é exclusivo para gestores autorizados da corretora. Se você é da equipe, peça ao administrador para liberar o seu número. 🔒";
    await input.enviar(recusa).catch(() => {});
    logger.info("[copiloto] número não autorizado — recusado", { canalId: input.canalId });
    return { atendido: false, resposta: recusa, toolsUsadas: [], motivo: "nao_autorizado" };
  }

  const config = await lerGestorConfig(identidade.corretoraId);
  if (!config.ativo) {
    const aviso = "O Copiloto ainda não está habilitado para esta corretora. Fale com o administrador. ⚙️";
    await input.enviar(aviso).catch(() => {});
    return { atendido: false, resposta: aviso, toolsUsadas: [], motivo: "corretora_desligada" };
  }

  // Persistência isolada + histórico.
  const gestorConversaId = await obterOuCriarGestorConversa({
    corretoraId: identidade.corretoraId,
    canalId: input.canalId,
    gestorId: identidade.gestorId,
    jid: input.jidRemoto,
  });
  await registrarMsgGestor({ gestorConversaId, origem: "gestor", corpo: input.textoGestor });
  const historico = await carregarHistoricoGestor(gestorConversaId);

  const podePdf = config.permitePdf && !!input.enviarDocumento;
  const podeGrafico = config.permiteGrafico && env.GESTOR_GRAFICO_ENABLED && !!input.enviarImagem;
  const ctx: ExecutorCtx = {
    corretoraId: identidade.corretoraId,
    canalId: input.canalId,
    jid: input.jidRemoto,
    config,
    gestorConversaId,
    enviarDocumento: podePdf ? input.enviarDocumento : undefined,
    enviarImagem: podeGrafico ? input.enviarImagem : undefined,
  };

  try {
    const resultado = await chamarCopiloto({
      systemBase: SYSTEM_BASE,
      systemDinamico: buildSystemDinamico(identidade, podePdf, podeGrafico),
      historico,
      tools: montarTools(ctx),
      executarTool: montarExecutor(ctx),
    });
    const resposta =
      resultado.texto ||
      "Não consegui montar a resposta agora. Pode reformular ou tentar de novo? 🙏";
    await input.enviar(resposta);
    await registrarMsgGestor({
      gestorConversaId,
      origem: "assistente",
      corpo: resposta,
      toolsUsadas: resultado.toolsUsadas,
    });
    return { atendido: true, resposta, toolsUsadas: resultado.toolsUsadas, motivo: "ok" };
  } catch (e) {
    logger.error("[copiloto] falha ao processar", { canalId: input.canalId, erro: (e as Error).message });
    const erroMsg = "Tive um problema para consultar os dados agora 😕 Pode tentar de novo em instantes?";
    await input.enviar(erroMsg).catch(() => {});
    await registrarMsgGestor({ gestorConversaId, origem: "assistente", corpo: erroMsg }).catch(() => {});
    return { atendido: false, resposta: erroMsg, toolsUsadas: [], motivo: "erro" };
  }
}
