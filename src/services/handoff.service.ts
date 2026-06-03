/**
 * Detecção e execução de handoff bot → humano.
 *
 * Gatilhos (spec §9.1): frases explícitas + manifestação de insatisfação +
 * temas que exigem corretor (sinistro, cancelamento). Mais o contador de
 * tentativas no mesmo campo, que é responsabilidade do bot.service.
 *
 * Execução: UPDATE conversas SET estado='humano_assumiu'. A notificação ao
 * operador é automática pela trigger `trg_conversas_handoff` (migration
 * 20260528100503).
 */
import { getSupabaseAdmin } from "../integrations/whatsapp/supabase";
import { logger } from "../utils/logger";

// Frases normalizadas (lowercase, sem acento). Match por inclusão de substring
// (palavra-chave) — não regex completa para evitar false negatives.
const GATILHOS: ReadonlyArray<string> = [
  // Pedido explícito
  "falar com humano",
  "falar com um humano",
  "falar com atendente",
  "falar com corretor",
  "falar com a equipe",
  "falar com alguem",
  "quero um humano",
  "atendente humano",
  "humano por favor",
  "me liga",
  "me ligue",
  "ligar pra mim",
  "ligacao",
  "telefonar",
  // Insatisfação
  "absurdo",
  "ridiculo",
  "pessimo",
  "horrivel",
  "reclamacao",
  "reclamar",
  "cancelar",
  "cancelamento",
  // Situações complexas
  "sinistro",
  "acidente",
  "bati o carro",
  "bati meu carro",
  "roubaram",
  "roubo",
  "furto",
  // Resposta direta ao prompt do bot
  " humano",
  "humano.",
  "humano!",
];

function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

/** Famílias de motivo do handoff, para o alerta legível ao operador. */
export type MotivoHandoff = "pedido_humano" | "insatisfacao" | "urgencia" | "vip";

const GATILHOS_INSATISFACAO: ReadonlyArray<string> = [
  "absurdo",
  "ridiculo",
  "pessimo",
  "horrivel",
  "reclamacao",
  "reclamar",
  "cancelar",
  "cancelamento",
];

const GATILHOS_URGENCIA: ReadonlyArray<string> = [
  "sinistro",
  "acidente",
  "bati o carro",
  "bati meu carro",
  "roubaram",
  "roubo",
  "furto",
];

/**
 * Classifica a palavra-chave de gatilho na família de motivo correspondente.
 * Default = "pedido_humano" (os demais gatilhos são pedidos explícitos de humano).
 * Recebe a palavra-chave já normalizada que `detectarGatilhoHandoff` retorna.
 */
export function classificarMotivoHandoff(gatilho: string): MotivoHandoff {
  const g = normalizar(gatilho);
  if (GATILHOS_INSATISFACAO.some((k) => g.includes(k))) return "insatisfacao";
  if (GATILHOS_URGENCIA.some((k) => g.includes(k))) return "urgencia";
  return "pedido_humano";
}

const LABEL_MOTIVO: Record<MotivoHandoff, string> = {
  pedido_humano: "Cliente pediu para falar com um humano",
  insatisfacao: "Possível insatisfação / rispidez do cliente",
  urgencia: "Urgência (sinistro/acidente/roubo)",
  vip: "Cliente VIP",
};

export interface MontarMensagemAlertaInput {
  motivo: MotivoHandoff;
  apelidoLinha: string;
  telefoneCliente: string | null;
  nomeCliente?: string | null;
}

/**
 * Texto fixo do alerta que a Bia envia ao operador (não vai a Claude). Identifica
 * a linha, o cliente (nome ou telefone) e o motivo.
 */
export function montarMensagemAlerta(input: MontarMensagemAlertaInput): string {
  const cliente = input.nomeCliente?.trim() || input.telefoneCliente || "cliente (sem identificação)";
  return [
    `🔔 Atendimento precisa de você — linha ${input.apelidoLinha}`,
    `Cliente: ${cliente}`,
    `Motivo: ${LABEL_MOTIVO[input.motivo]}`,
    "A Bia pausou e a conversa está aguardando um corretor.",
  ].join("\n");
}

export function detectarGatilhoHandoff(texto: string): { detectado: boolean; gatilho?: string } {
  const t = normalizar(texto);
  // Casos de uma palavra só: "humano", "humano." etc.
  if (t === "humano" || t === "humano." || t === "humano!" || t === "1") {
    // "1" só vira gatilho se vier de um menu — bot.service controla isso por contexto
    if (t !== "1") return { detectado: true, gatilho: "humano" };
  }
  for (const g of GATILHOS) {
    if (t.includes(g)) return { detectado: true, gatilho: g };
  }
  return { detectado: false };
}

export interface ExecutarHandoffInput {
  conversaId: string;
  motivo: string;
}

export async function executarHandoff(input: ExecutarHandoffInput): Promise<void> {
  const sb = getSupabaseAdmin();
  const { error } = await sb
    .from("conversas")
    .update({
      estado: "humano_assumiu",
      // dados_bot poderia receber o motivo, mas a coluna pode não existir em prod.
      // Logamos o motivo aqui; a notificação dispara via trigger.
    })
    .eq("id", input.conversaId);
  if (error) {
    logger.error("[handoff] falha ao mudar estado", {
      conversaId: input.conversaId,
      erro: error.message,
    });
    throw error;
  }
  logger.info("[handoff] conversa transferida para humano", {
    conversaId: input.conversaId,
    motivo: input.motivo,
  });
}

/**
 * Mensagem padronizada que a Bia envia ao cliente IMEDIATAMENTE ANTES do
 * handoff. Texto fixo (não vai a Claude) para garantir consistência e
 * economizar tokens.
 */
export const MENSAGEM_HANDOFF =
  "Sem problema! Já estou chamando um corretor da nossa equipe para te atender. Em instantes alguém entra em contato. 👋";
