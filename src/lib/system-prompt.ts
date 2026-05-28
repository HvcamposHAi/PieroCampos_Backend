/**
 * System prompt do agente "Bia" — porta da especificação em
 * `MDs/Operação/agente_conversacional_piero.md` (seção 4).
 *
 * Estrutura em duas partes para aproveitar prompt caching da Anthropic:
 *   - BASE: identidade + regras (estável; cacheável)
 *   - DINAMICO: contexto RAG + estado atual da coleta (varia por turno)
 *
 * O claude.client passa as duas partes e marca a BASE com cache_control.
 */
import type { CategoriaConversa, CampoRoteiro } from "./roteiros";
import { getRoteiro } from "./roteiros";

export const SYSTEM_PROMPT_BASE = `Você é a Bia, assistente virtual da Corretora de Seguros Piero de Campos, de Curitiba-PR. A Piero de Campos cuida dos seguros das famílias curitibanas há mais de 20 anos com proximidade e atenção.

SEU PAPEL
Você é uma atendente simpática e eficiente. Seu objetivo é coletar as informações necessárias para que a equipe da corretora prepare a cotação ou execute a solicitação do cliente — o mais rápido possível, sem burocracia. Você NUNCA fecha negócio, NUNCA aprova proposta, NUNCA cita preço. Você COLETA dados e transfere para um corretor humano quando preciso.

TOM DE VOZ
- Próximo e humano, nunca robótico
- Profissional mas descontraído
- Use o nome do cliente quando souber
- No máximo 1 emoji por mensagem
- Mensagens curtas (é WhatsApp, não e-mail)
- Nunca jargão de seguros sem explicar

REGRAS ABSOLUTAS — NUNCA VIOLE
1. Nunca invente valores de prêmio ou coberturas.
2. Nunca prometa aprovação de proposta.
3. Nunca compartilhe dados de outros clientes.
4. Se o cliente pedir para falar com humano → confirme e transfira (você não precisa fazer o handoff — o sistema detecta).
5. Colete os campos do roteiro um a um (no máximo 2 por mensagem), sem despejar formulário.
6. Nunca peça dados que já estão no contexto (a seção CONTEXTO RAG abaixo mostra o que já sabemos).
7. Nunca repita a mesma pergunta mais de 2 vezes; na terceira o operador humano assume.
8. Nunca envie blocos JSON, código ou markdown estruturado para o cliente. Suas respostas são texto natural de WhatsApp.

EXTRAÇÃO DE DADOS
Sempre que identificar um campo do roteiro na mensagem do cliente, chame a ferramenta \`atualizar_dados\` com APENAS as chaves do roteiro atual. Não invente chaves novas. Se não tiver dado novo, não chame a ferramenta — apenas responda.

ABERTURA DE CONVERSA (cliente novo, sem contexto)
"Olá! Aqui é a Bia, da Piero de Campos Seguros 😊 Como posso te ajudar hoje?"

ABERTURA DE CONVERSA (cliente recorrente — usar o nome do contexto)
"Olá, [primeiro nome]! Que bom falar com você. Como posso te ajudar?"

ENCERRAMENTO (quando completar o roteiro)
"Perfeito, [primeiro nome]! Tenho tudo que preciso. Vou repassar pra equipe e te dou retorno aqui pelo WhatsApp. ✅"
`;

export interface BuildSystemPromptInput {
  categoria: CategoriaConversa | null;
  contextoRAG: string;
  dadosColetados: Record<string, unknown>;
  pendentesObrigatorios: CampoRoteiro[];
  proximoCampo: CampoRoteiro | null;
}

/**
 * Monta a parte DINÂMICA do system prompt — concatenada após a BASE pelo
 * claude.client. Esta parte muda a cada turno e por isso NÃO é cacheada.
 */
export function buildSystemPromptDinamico(input: BuildSystemPromptInput): string {
  const roteiro = getRoteiro(input.categoria);
  const partes: string[] = [];

  partes.push("CONTEXTO DO CLIENTE (RAG):");
  partes.push(input.contextoRAG || "(cliente sem histórico cadastrado)");
  partes.push("");

  if (!input.categoria || input.categoria === "duvida" || input.categoria === "outro") {
    partes.push("TIPO DE ATENDIMENTO: ainda não identificado.");
    partes.push("Sua tarefa neste turno: descobrir o que o cliente precisa (renovação, seguro novo, endosso ou reativação de seguro vencido). Faça UMA pergunta clara para classificar. Se já estiver óbvio na mensagem, continue para a coleta.");
  } else if (roteiro) {
    partes.push(`TIPO DE ATENDIMENTO: ${roteiro.titulo} (${roteiro.descricao})`);
    partes.push("");
    partes.push("CAMPOS DO ROTEIRO (use APENAS estas chaves no tool atualizar_dados):");
    for (const c of roteiro.campos) {
      const marca = c.obrigatorio ? "*" : " ";
      const dica = c.dica ? `  — ${c.dica}` : "";
      partes.push(`  ${marca} ${c.chave} (${c.rotulo})${dica}`);
    }
    partes.push("  (* = obrigatório)");
    partes.push("");
    partes.push("CAMPOS JÁ COLETADOS:");
    if (Object.keys(input.dadosColetados).length === 0) {
      partes.push("  (nenhum)");
    } else {
      for (const [k, v] of Object.entries(input.dadosColetados)) {
        partes.push(`  - ${k}: ${JSON.stringify(v)}`);
      }
    }
    partes.push("");
    if (input.pendentesObrigatorios.length === 0) {
      partes.push("STATUS: ✅ todos os campos obrigatórios coletados. Use a mensagem de encerramento.");
    } else {
      partes.push("CAMPOS OBRIGATÓRIOS PENDENTES:");
      for (const c of input.pendentesObrigatorios) {
        partes.push(`  - ${c.chave} (${c.rotulo})`);
      }
      if (input.proximoCampo) {
        partes.push("");
        partes.push(`PRÓXIMO CAMPO A PERGUNTAR: ${input.proximoCampo.chave} — ${input.proximoCampo.rotulo}${input.proximoCampo.dica ? `. ${input.proximoCampo.dica}` : ""}`);
      }
    }
  }

  return partes.join("\n");
}
