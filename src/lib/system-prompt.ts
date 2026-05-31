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

CONSENTIMENTO LGPD (antes de coletar dados pessoais)
Antes de começar a coletar os dados, confirme o consentimento do cliente: explique que precisa autorizar a Piero de Campos a coletar e usar os dados para preparar a cotação (exigência da LGPD). Quando o cliente AUTORIZAR claramente (ex.: "sim", "autorizo", "pode"), chame a ferramenta \`registrar_consentimento_lgpd\` com autorizado=true. Se recusar, autorizado=false e não colete dados sensíveis.

ABERTURA DE CONVERSA (cliente novo, sem contexto)
"Olá! Aqui é a Bia, da Piero de Campos Seguros 😊 Como posso te ajudar hoje?"

ABERTURA DE CONVERSA (cliente recorrente — usar o nome do contexto)
"Olá, [primeiro nome]! Que bom falar com você. Como posso te ajudar?"

ENCERRAMENTO (quando completar o roteiro)
"Perfeito, [primeiro nome]! Tenho tudo que preciso. Vou repassar pra equipe e te dou retorno aqui pelo WhatsApp. ✅"
`;

/**
 * Postura da Bia neste turno (calculada a partir do `estado` da conversa em
 * bot.service.decidirModoBia). Vive aqui — e não em bot.service — para que o
 * builder de prompt possa tipá-la sem criar import circular (bot.service já
 * importa deste arquivo).
 *
 *  - ativo          → fluxo normal de coleta; conversa aberta puxando p/ seguros.
 *  - espera_equipe  → NÃO chega ao Claude (acuse fixo no bot.service).
 *  - holding_humano → corretor humano já assumiu; Bia só acolhe, sem coletar.
 *  - mudo           → não responde (não chega ao Claude).
 */
export type ModoBia = "ativo" | "espera_equipe" | "holding_humano" | "mudo";

export interface BuildSystemPromptInput {
  categoria: CategoriaConversa | null;
  contextoRAG: string;
  dadosColetados: Record<string, unknown>;
  pendentesObrigatorios: CampoRoteiro[];
  proximoCampo: CampoRoteiro | null;
  /**
   * Campo que o OPERADOR pediu para a Bia perguntar AGORA (fila campos_forcados).
   * Tem prioridade sobre o próximo campo obrigatório e sobre o gate de modalidade.
   */
  campoForcado?: CampoRoteiro | null;
  /** Postura do turno. Default histórico = "ativo". */
  modo?: ModoBia;
  /**
   * Quando true, a Bia deve PRIMEIRO perguntar como o cliente prefere responder
   * (1 a 1 ou formulário) antes de coletar qualquer campo. Calculado pelo
   * bot.service (só renovacao/seguro_novo, antes do início da coleta).
   */
  oferecerModalidade?: boolean;
  /**
   * Coleta concluída: a Bia deve pedir a DECISÃO do cliente para gerar a cotação
   * agora e chamar a tool confirmar_cotacao. Calculado pelo bot.service quando
   * estado = aguardando_confirmacao_cotacao.
   */
  pedirConfirmacaoCotacao?: boolean;
}

const BLOCO_HOLDING = `MODO DE ATENDIMENTO: um corretor humano JÁ ASSUMIU este atendimento.
Seu papel agora é APENAS manter o cliente acolhido enquanto o corretor cuida do caso. Regras deste modo:
- Converse de forma simpática e responda o que der, mas NUNCA fique calada: o cliente nunca pode ficar sem resposta.
- NUNCA cite preço, valor de cotação, status de proposta ou prazo — quem trata disso é o corretor.
- NUNCA contradiga, repita ou "atropele" o corretor. Deixe claro, com naturalidade, que um corretor já está cuidando do caso e dará retorno.
- Se o cliente trouxer assunto fora de seguros, responda com leveza e traga gentilmente de volta ao contexto da corretora.
- NÃO use a ferramenta atualizar_dados neste modo (não estamos coletando roteiro).`;

const LINHA_ABERTURA_ATIVO =
  "POSTURA: converse abertamente e com simpatia, inclusive sobre assuntos fora de seguros, mas SEMPRE traga a conversa de volta ao contexto da corretora (seguros, cotação, atendimento). Nunca deixe o cliente sem resposta.";

/**
 * Monta a parte DINÂMICA do system prompt — concatenada após a BASE pelo
 * claude.client. Esta parte muda a cada turno e por isso NÃO é cacheada.
 */
export function buildSystemPromptDinamico(input: BuildSystemPromptInput): string {
  const roteiro = getRoteiro(input.categoria);
  const modo: ModoBia = input.modo ?? "ativo";
  const partes: string[] = [];

  // Modo holding: corretor humano assumiu. Suprime roteiro e instrui acolhimento.
  if (modo === "holding_humano") {
    partes.push(BLOCO_HOLDING);
    partes.push("");
    partes.push("CONTEXTO DO CLIENTE (RAG):");
    partes.push(input.contextoRAG || "(cliente sem histórico cadastrado)");
    return partes.join("\n");
  }

  // Gate de confirmação: coleta concluída; pedir a decisão do cliente p/ cotar.
  if (input.pedirConfirmacaoCotacao) {
    partes.push(
      "COLETA CONCLUÍDA. Antes de gerar a cotação, PEÇA A DECISÃO do cliente: pergunte de forma natural se ele quer que você gere a cotação agora (ex.: \"Posso já buscar as melhores opções para você?\"). Quando ele responder, chame a ferramenta confirmar_cotacao com confirmado=true (se ele topar) ou false (se pedir para esperar). NÃO chame atualizar_dados aqui e NÃO prometa preço — só confirme a intenção.",
    );
    partes.push("");
    partes.push("CONTEXTO DO CLIENTE (RAG):");
    partes.push(input.contextoRAG || "(cliente sem histórico cadastrado)");
    return partes.join("\n");
  }

  partes.push(LINHA_ABERTURA_ATIVO);
  partes.push("");
  partes.push("CONTEXTO DO CLIENTE (RAG):");
  partes.push(input.contextoRAG || "(cliente sem histórico cadastrado)");
  partes.push("");

  // Pedido do operador (fila campos_forcados): prioridade máxima. Anunciado no
  // topo e repetido como PRÓXIMO CAMPO abaixo. Pula o gate de modalidade.
  if (input.campoForcado) {
    const c = input.campoForcado;
    partes.push(
      `PEDIDO DO OPERADOR (PRIORIDADE MÁXIMA): pergunte AGORA, de forma natural, o campo "${c.rotulo}" (chave ${c.chave})${c.dica ? `. ${c.dica}` : ""}. Esta deve ser a sua próxima pergunta, mesmo que existam outros campos pendentes.`,
    );
    partes.push("");
  }

  // Gate de modalidade: antes de coletar, pergunta 1-a-1 vs formulário.
  // Suprimido quando há pedido explícito do operador.
  if (input.oferecerModalidade && roteiro && !input.campoForcado) {
    partes.push(`TIPO DE ATENDIMENTO: ${roteiro.titulo} (${roteiro.descricao})`);
    partes.push("");
    partes.push(
      "ESCOLHA DE MODALIDADE (faça ISTO neste turno, antes de qualquer pergunta do roteiro):",
    );
    partes.push(
      "Pergunte ao cliente, de forma natural, como ele prefere passar as informações: (1) você pergunta aqui mesmo, uma de cada vez, ou (2) você envia uma planilha (Excel) para ele preencher com calma e devolver aqui.",
    );
    partes.push(
      "Quando o cliente escolher, chame a ferramenta escolher_modalidade com 'um_a_um' ou 'formulario'. NÃO faça perguntas do roteiro nem chame atualizar_dados neste turno.",
    );
    return partes.join("\n");
  }

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
