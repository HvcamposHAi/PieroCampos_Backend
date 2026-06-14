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
import type { CategoriaConversa, CampoRoteiro, PerguntaCustom } from "./roteiros";
import { getRoteiroEfetivo, montarResumoRevisao } from "./roteiros";
import type { ConfigEfetiva, Emojis, Objetivo, TomVoz } from "../services/agente-config.service";

export const SYSTEM_PROMPT_BASE = `Você é a Bia, assistente virtual da Corretora de Seguros Piero de Campos, de Curitiba-PR. A Piero de Campos cuida dos seguros das famílias curitibanas há mais de 20 anos com proximidade e atenção.

SEU PAPEL
Você é uma atendente simpática e eficiente. Seu objetivo é coletar as informações necessárias para que a equipe da corretora prepare a cotação ou execute a solicitação do cliente — o mais rápido possível, sem burocracia. Você NUNCA fecha negócio, NUNCA aprova proposta, NUNCA cita preço. Você COLETA dados e transfere para um corretor humano quando preciso.

TOM DE VOZ
- Próximo e humano, nunca robótico
- Profissional mas descontraído
- Use o nome do cliente quando souber
- Use emojis com parcimônia (no máximo 1 por mensagem), salvo orientação de estilo abaixo
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

ENDEREÇO (CEP)
Ao coletar o endereço, peça SEMPRE três coisas: CEP, número e complemento. Assim que o cliente informar o CEP, chame a ferramenta \`consultar_cep\` com o CEP — ela devolve o logradouro, bairro, cidade e UF. Mostre esse endereço ao cliente e PEÇA CONFIRMAÇÃO antes de seguir (ex.: "Encontrei: Rua X, Bairro Y, Cidade-UF. Está correto?"). Só prossiga depois que ele confirmar. Pergunte o número e o complemento (registre com \`atualizar_dados\` nas chaves numero e complemento). Se a consulta não encontrar o CEP, peça ao cliente o logradouro, bairro, cidade e UF manualmente.

CONSENTIMENTO LGPD (antes de coletar dados pessoais)
Antes de começar a coletar os dados, confirme o consentimento do cliente: explique que precisa autorizar a Piero de Campos a coletar e usar os dados para preparar a cotação (exigência da LGPD). Quando o cliente AUTORIZAR claramente (ex.: "sim", "autorizo", "pode"), chame a ferramenta \`registrar_consentimento_lgpd\` com autorizado=true. Se recusar, autorizado=false e não colete dados sensíveis.

ABERTURA DE CONVERSA (cliente novo, sem contexto)
"Olá! Aqui é a Bia, da Piero de Campos Seguros 😊 Como posso te ajudar hoje?"

ABERTURA DE CONVERSA (cliente recorrente — usar o nome do contexto)
"Olá, [primeiro nome]! Que bom falar com você. Como posso te ajudar?"

ENCERRAMENTO (APENAS quando TODOS os campos obrigatórios estiverem preenchidos — nunca antes)
"Perfeito, [primeiro nome]! Tenho tudo que preciso. Vou repassar pra equipe e te dou retorno aqui pelo WhatsApp. ✅"
`;

/**
 * Postura da Bia neste turno (calculada a partir do `estado` da conversa em
 * bot.service.decidirModoBia). Vive aqui — e não em bot.service — para que o
 * builder de prompt possa tipá-la sem criar import circular (bot.service já
 * importa deste arquivo).
 *
 *  - ativo   → fluxo normal de coleta; conversa aberta puxando p/ seguros.
 *  - holding → equipe/corretor cuidando (cotação, humano assumiu, apólice, VIP):
 *              a Bia SÓ acolhe (nunca fica calada), sem coletar nem dar preço.
 *  - mudo    → não responde (só `encerrado`; nova msg reabre como conversa nova).
 */
export type ModoBia = "ativo" | "holding" | "mudo";

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
   * 1ª linha do bloco de holding — explica POR QUE a equipe está cuidando
   * (cotação em preparo / humano assumiu / apólice / VIP). Calculado no
   * bot.service a partir do estado. Só usado quando modo === "holding".
   */
  contextoHolding?: string;
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
  /**
   * Cliente recorrente: a Bia deve apresentar TODOS os dados já capturados numa
   * ÚNICA mensagem e perguntar se algo mudou (em vez de re-perguntar campo a
   * campo). Calculado pelo bot.service quando dados_bot.revisao_pendente é true.
   */
  revisaoPendente?: boolean;
  /**
   * Chaves de campos OPCIONAIS que a linha desligou (Admin > Bia). Filtrados da
   * lista de campos a perguntar. Obrigatórios nunca saem. Default = [].
   */
  camposExcluidos?: string[];
  /** Perguntas customizadas da linha (anexadas como campos opcionais). Default = []. */
  camposCustom?: PerguntaCustom[];
  /** Sistema de cotação da corretora — define os campos auto do roteiro. Default = segfy. */
  sistema?: string;
}

const CONTEXTO_HOLDING_PADRAO = "MODO DE ATENDIMENTO: a equipe já está cuidando deste atendimento.";

const BLOCO_HOLDING_REGRAS = `Seu papel agora é APENAS manter o cliente acolhido enquanto a equipe cuida do caso. Regras deste modo:
- Converse de forma simpática e responda o que der, mas NUNCA fique calada: o cliente nunca pode ficar sem resposta.
- NUNCA cite preço, valor de cotação, status de proposta ou prazo — quem trata disso é a equipe/o corretor.
- NUNCA contradiga, repita ou "atropele" a equipe. Deixe claro, com naturalidade, que já estão cuidando do caso e darão retorno.
- Se o cliente trouxer assunto fora de seguros, responda com leveza e traga gentilmente de volta ao contexto da corretora.
- NÃO use a ferramenta atualizar_dados neste modo (não estamos coletando roteiro).`;

const LINHA_ABERTURA_ATIVO =
  "POSTURA: converse abertamente e com simpatia, inclusive sobre assuntos fora de seguros, mas SEMPRE traga a conversa de volta ao contexto da corretora (seguros, cotação, atendimento). Nunca deixe o cliente sem resposta.";

/**
 * Monta a parte DINÂMICA do system prompt — concatenada após a BASE pelo
 * claude.client. Esta parte muda a cada turno e por isso NÃO é cacheada.
 */
export function buildSystemPromptDinamico(input: BuildSystemPromptInput): string {
  const roteiro = getRoteiroEfetivo(
    input.categoria,
    input.camposExcluidos,
    input.camposCustom,
    "auto",
    input.sistema,
  );
  const modo: ModoBia = input.modo ?? "ativo";
  const partes: string[] = [];

  // Modo holding: equipe/corretor cuidando. Suprime roteiro e instrui acolhimento
  // (a Bia NUNCA fica calada). A 1ª linha varia conforme o estado (contextoHolding).
  if (modo === "holding") {
    partes.push(input.contextoHolding || CONTEXTO_HOLDING_PADRAO);
    partes.push(BLOCO_HOLDING_REGRAS);
    partes.push("");
    partes.push("CONTEXTO DO CLIENTE (RAG):");
    partes.push(input.contextoRAG || "(cliente sem histórico cadastrado)");
    return partes.join("\n");
  }

  // Gate de revisão: cliente recorrente. Apresenta TUDO o que já temos numa única
  // mensagem e pergunta se mudou algo — sem re-perguntar campo a campo. O bloco de
  // PERSONALIZAÇÃO (tom/saudação) é separado (claude.client) e segue valendo.
  if (input.revisaoPendente) {
    const resumo = montarResumoRevisao(
      input.categoria,
      input.dadosColetados,
      input.camposExcluidos,
      input.camposCustom,
      "auto",
      input.sistema,
    );
    partes.push(
      "CLIENTE RECORRENTE (REVISÃO DE DADOS): já temos os dados abaixo de um atendimento anterior. NÃO recomece o roteiro nem pergunte campo a campo.",
    );
    partes.push(
      "Sua tarefa neste turno: numa ÚNICA mensagem, cumprimente o cliente pelo nome (se souber), liste de forma organizada os dados que já temos e pergunte, de forma natural, se algo mudou ou se está tudo certo. Se o cliente JÁ informou alguma mudança CONCRETA nesta conversa (ex.: placa nova, e-mail novo, veículo diferente), chame `atualizar_dados` com ESSAS chaves AGORA (e `confirmar_revisao` com mudou=true). Se for só a apresentação inicial e ele ainda não disse o que mudou, não chame `atualizar_dados` ainda.",
    );
    partes.push("");
    partes.push("DADOS QUE JÁ TEMOS DESTE CLIENTE:");
    if (resumo.length === 0) {
      partes.push("  (nenhum)");
    } else {
      for (const linha of resumo) partes.push(`  ${linha}`);
    }
    // Obrigatórios que o cliente recorrente ainda NÃO tem salvos (ex.: o sistema
    // da corretora passou a exigir data_nascimento/sexo). Sem isto, a Bia não
    // sabe o que falta e encerra cedo ("repasso pra equipe"). Trava o encerramento.
    const pendentesRev = input.pendentesObrigatorios ?? [];
    if (pendentesRev.length > 0) {
      partes.push("");
      partes.push(
        "⚠️ AINDA FALTAM estes dados OBRIGATÓRIOS para cotar (o cliente recorrente não os tem salvos):",
      );
      for (const c of pendentesRev) partes.push(`  - ${c.rotulo}`);
      partes.push(
        "Depois de confirmar o que mudou, COLETE esses campos com o cliente, de forma natural. NUNCA diga que \"tem tudo\" nem fale em \"repassar para a equipe\" enquanto faltar algum obrigatório.",
      );
    }
    partes.push("");
    partes.push(
      "Quando o cliente responder: chame a ferramenta confirmar_revisao com mudou=false (se estiver tudo certo) ou mudou=true (se algo mudou). Se mudou=true, chame TAMBÉM atualizar_dados APENAS com as chaves que mudaram.",
    );
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

/**
 * Descrição de cada tom de voz configurável. Texto que entra no bloco de
 * PERSONALIZAÇÃO (bloco 2 do system prompt) — só ajusta forma, nunca conteúdo.
 */
const TOM_DESCRICAO: Record<TomVoz, string> = {
  proximo_caloroso: "próximo, caloroso e acolhedor, como uma amiga da família curitibana",
  formal_profissional: "formal e profissional, cortês e objetivo",
  direto_objetivo: "direto e objetivo, sem rodeios, mas sempre educado",
  entusiasta: "entusiasta e animado, transmitindo energia positiva",
};

/**
 * Instrução de uso de emoji por nível configurável. Sobrepõe a baseline suave da
 * BASE (que vale quando NÃO há config). 'moderado' reproduz o comportamento atual.
 */
const EMOJI_INSTRUCAO: Record<Emojis, string> = {
  sem: "Não use emojis nas mensagens.",
  moderado: "Use no máximo 1 emoji por mensagem.",
  a_vontade: "Pode usar emojis à vontade (vários por mensagem, com naturalidade).",
};

/**
 * Objetivo/postura da Bia nesta linha. É uma ORIENTAÇÃO de intenção — não muda
 * o roteiro de coleta nem libera citar preço/aprovar (isso fica na BASE).
 */
const OBJETIVO_DESCRICAO: Record<Objetivo, string> = {
  cotacao: "coletar os dados necessários e encaminhar a cotação o quanto antes, sem burocracia",
  atendimento: "atender e tirar as dúvidas do cliente com excelência, sem pressa de cotar",
  aquecer: "aquecer e estreitar o relacionamento com o cliente, mantendo-o engajado e bem cuidado",
  venda:
    "conduzir o cliente a avançar na contratação, destacando os benefícios — sempre sem citar preço nem prometer aprovação",
};

/**
 * Monta o bloco 2 (PERSONALIZAÇÃO por canal), concatenado entre a BASE e a
 * DINÂMICA pelo claude.client. Só ajusta ESTILO (tom/persona/saudação/exemplos);
 * o cabeçalho deixa explícito que NÃO sobrepõe as REGRAS ABSOLUTAS da BASE.
 * Função pura (testável). Devolve "" se não houver nada de estilo a acrescentar.
 */
export function buildBlocoPersonalizacao(config: ConfigEfetiva): string {
  const partes: string[] = [
    "AJUSTE DE ESTILO DESTA LINHA (apenas tom e forma; NUNCA sobrepõe as REGRAS ABSOLUTAS acima — preço, aprovação, dados de terceiros e LGPD seguem valendo):",
    `- Tom de voz: ${TOM_DESCRICAO[config.tomVoz] ?? TOM_DESCRICAO.proximo_caloroso}.`,
    `- Objetivo nesta linha: ${OBJETIVO_DESCRICAO[config.objetivo] ?? OBJETIVO_DESCRICAO.cotacao}.`,
    `- Emojis: ${EMOJI_INSTRUCAO[config.emojis] ?? EMOJI_INSTRUCAO.moderado}`,
  ];

  if (config.persona) {
    partes.push(`- Abordagem/personalidade: ${config.persona}`);
  }
  if (config.saudacao) {
    partes.push(
      `- Ao iniciar uma conversa nova, use esta saudação como referência (adapte ao nome do cliente quando souber): "${config.saudacao}"`,
    );
  }
  if (config.exemplos) {
    partes.push(
      "- Exemplos do jeito de escrever (referência de ESTILO, não copie literalmente nem invente conteúdo):",
    );
    for (const linha of config.exemplos.split("\n").map((l) => l.trim()).filter(Boolean)) {
      partes.push(`  • ${linha}`);
    }
  }
  if (config.estiloAmostra) {
    partes.push(
      "- CLONAGEM DE ESTILO: imite o JEITO DE ESCREVER do corretor humano nos exemplos abaixo — vocabulário, bordões, ritmo das frases e hábito de emojis. Incorpore esse estilo de forma natural; NÃO copie as mensagens ao pé da letra nem invente fatos/valores que não vieram do cliente.",
    );
    partes.push(
      "  Quando o cliente puxar assunto fora de seguros, você pode conversar com mais liberdade NESSE MESMO ESTILO, mantendo a leveza — e sempre retome com naturalidade o contexto da corretora. As REGRAS ABSOLUTAS (preço, aprovação, dados de terceiros, LGPD) continuam valendo integralmente.",
    );
    for (const linha of config.estiloAmostra.split("\n").map((l) => l.trim()).filter(Boolean)) {
      partes.push(`  • ${linha}`);
    }
  }
  if (config.variarTexto) {
    partes.push(
      "- Varie as frases entre as mensagens; evite repetir as mesmas construções e aberturas.",
    );
  }

  return partes.join("\n");
}
