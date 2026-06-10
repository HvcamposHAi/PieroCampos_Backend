/**
 * Roteiros do agente Bia — campos a coletar por categoria de atendimento.
 *
 * Espelha [piero-broker-assist/src/lib/bot-scripts.ts](piero-broker-assist/src/lib/bot-scripts.ts)
 * mas usa o ENUM `categoria_conversa` do banco (6 valores) em vez do tipo enxuto
 * do front (4 valores). `duvida` e `outro` não têm script — Bia responde livre
 * até classificar.
 *
 * Esta é a FONTE ÚNICA do backend. Se mudar, atualizar também o do front e
 * o mapeamento em `categoria-map.ts`. O risco de divergência está documentado
 * no plano (R9 de perceba-que-saudacao).
 */

export type CategoriaConversa =
  | "renovacao"
  | "seguro_novo"
  | "endosso"
  | "nao_renovado"
  | "duvida"
  | "outro";

/**
 * Ramos de seguro suportados. Espelha o ENUM `ramo` do banco
 * (auto/residencial/vida/empresarial + 'saude' adicionado na migração SaaS).
 *
 * `auto` é o ÚNICO ramo com cotação automatizada (Segfy). Os demais coletam
 * dados e geram cotação NÃO-AUTOMATIZADA (status 'pendente' → operador). Ver
 * `integrations/quote/registry.ts`.
 */
export type Ramo = "auto" | "residencial" | "vida" | "empresarial" | "saude";

/** Todos os ramos suportados (ordem estável p/ UI e seed de corretora_ramos). */
export const RAMOS_VALIDOS: readonly Ramo[] = [
  "auto",
  "residencial",
  "vida",
  "empresarial",
  "saude",
];

export const RAMO_PADRAO: Ramo = "auto";

/** Normaliza um ramo vindo do banco (string|null) para o tipo, default 'auto'. */
export function normalizarRamo(ramo: string | null | undefined): Ramo {
  switch (ramo) {
    case "residencial":
    case "vida":
    case "empresarial":
    case "saude":
      return ramo;
    default:
      return "auto";
  }
}

export interface CampoRoteiro {
  chave: string;
  rotulo: string;
  obrigatorio: boolean;
  dica?: string;
}

export interface Roteiro {
  id: CategoriaConversa;
  titulo: string;
  descricao: string;
  campos: CampoRoteiro[];
}

/**
 * Perguntas extras exigidas pelo MULTICÁLCULO do Segfy (Auto), com ÁRVORES DE
 * DECISÃO. A Bia coleta essas além dos campos comerciais; o mapeamento p/ a API
 * está em `segfy-cotacao.service.ts` (MAP_*). Campos condicionais ficam como
 * opcionais e a `dica` indica quando perguntar.
 *
 * ⚠️ Espelhar no front (bot-scripts.ts) — ver nota no topo deste arquivo.
 */
const PERGUNTAS_SEGFY_AUTO: CampoRoteiro[] = [
  { chave: "cpf", rotulo: "CPF", obrigatorio: true, dica: "Obrigatório p/ a cotação no Segfy (consulta do segurado). Peça com naturalidade e reforce a LGPD." },
  { chave: "placa", rotulo: "Placa do veículo", obrigatorio: true, dica: "Identifica o veículo e a FIPE automaticamente" },
  { chave: "profissao", rotulo: "Profissão", obrigatorio: true },
  { chave: "garagem", rotulo: "Garagem na residência?", obrigatorio: false, dica: "Tem garagem/portão fechado em casa? sim/não" },
  { chave: "trabalha", rotulo: "Trabalha?", obrigatorio: false, dica: "Se SIM → perguntar garagem_trabalho" },
  { chave: "garagem_trabalho", rotulo: "Garagem no trabalho?", obrigatorio: false, dica: "Só se trabalha=sim" },
  { chave: "estuda", rotulo: "Estuda?", obrigatorio: false, dica: "Se SIM → perguntar garagem_estudo" },
  { chave: "garagem_estudo", rotulo: "Garagem no local de estudo?", obrigatorio: false, dica: "Só se estuda=sim" },
  { chave: "km_mes", rotulo: "Km rodados por mês", obrigatorio: false, dica: "Ex.: 500" },
  { chave: "distancia_trabalho", rotulo: "Distância até o trabalho (km)", obrigatorio: false },
  { chave: "tipo_residencia", rotulo: "Tipo de residência", obrigatorio: false, dica: "casa, apartamento, condominio ou chacara" },
  { chave: "condutor_jovem", rotulo: "Reside com condutor de 18 a 26 anos?", obrigatorio: false, dica: "Tarifa muda muito. Se SIM → perguntar sexo_condutor_jovem e idade_condutor_secundario" },
  { chave: "sexo_condutor_jovem", rotulo: "Sexo do condutor jovem", obrigatorio: false, dica: "Só se condutor_jovem=sim: masculino/feminino" },
  { chave: "idade_condutor_secundario", rotulo: "Idade do condutor jovem", obrigatorio: false, dica: "Só se condutor_jovem=sim: 18-24 ou 25" },
];

const RENOVACAO: Roteiro = {
  id: "renovacao",
  titulo: "Renovação",
  descricao: "Coleta de dados para renovação de apólice.",
  campos: [
    { chave: "segurado", rotulo: "Segurado", obrigatorio: true },
    { chave: "corretor", rotulo: "Corretor", obrigatorio: false, dica: "Inferido do canal" },
    { chave: "comissao", rotulo: "Comissão", obrigatorio: false },
    { chave: "alteracao", rotulo: "Alteração", obrigatorio: false, dica: "Houve alguma alteração desde a apólice anterior?" },
    { chave: "telefone", rotulo: "Telefone", obrigatorio: false, dica: "Inferido do WhatsApp" },
    { chave: "email", rotulo: "E-mail", obrigatorio: true },
    { chave: "utilizacao_veiculo", rotulo: "Utilização do veículo", obrigatorio: true, dica: "Particular, trabalho, aplicativo..." },
    { chave: "dados_veiculo_fipe", rotulo: "Dados do veículo (FIPE)", obrigatorio: true },
    { chave: "bonus", rotulo: "Bônus", obrigatorio: false, dica: "0 a 10, está na apólice atual" },
    { chave: "estado_civil", rotulo: "Estado civil", obrigatorio: true },
    { chave: "cep", rotulo: "CEP", obrigatorio: true, dica: "CEP onde o carro pernoita. Consulte (tool consultar_cep) e CONFIRME o logradouro com o cliente." },
    { chave: "numero", rotulo: "Número", obrigatorio: true, dica: "Número do endereço." },
    { chave: "complemento", rotulo: "Complemento", obrigatorio: false, dica: "Pergunte sempre (apto/bloco/casa); aceite 'sem complemento'." },
    ...PERGUNTAS_SEGFY_AUTO,
  ],
};

const SEGURO_NOVO: Roteiro = {
  id: "seguro_novo",
  titulo: "Seguro novo",
  descricao: "Coleta de dados para contratação de seguro novo.",
  campos: [
    { chave: "segurado", rotulo: "Segurado", obrigatorio: true },
    { chave: "estado_civil", rotulo: "Estado civil", obrigatorio: true },
    { chave: "cep", rotulo: "CEP", obrigatorio: true, dica: "Peça o CEP; consulte (tool consultar_cep) e CONFIRME o logradouro com o cliente." },
    { chave: "numero", rotulo: "Número", obrigatorio: true, dica: "Número do endereço." },
    { chave: "complemento", rotulo: "Complemento", obrigatorio: false, dica: "Pergunte sempre (apto/bloco/casa); aceite 'sem complemento'." },
    { chave: "corretor", rotulo: "Corretor", obrigatorio: false, dica: "Inferido do canal / operador" },
    { chave: "comissao", rotulo: "Comissão", obrigatorio: false },
    { chave: "utilizacao_veiculo", rotulo: "Utilização do veículo", obrigatorio: true },
    { chave: "email", rotulo: "E-mail", obrigatorio: true },
    { chave: "telefone_contato", rotulo: "Telefone de contato", obrigatorio: false, dica: "Inferido do WhatsApp" },
    { chave: "rg", rotulo: "RG", obrigatorio: true },
    { chave: "dados_veiculo_fipe", rotulo: "Dados do veículo (FIPE)", obrigatorio: true },
    { chave: "renovacao_outro_corretor", rotulo: "Vinha de outro corretor?", obrigatorio: false },
    { chave: "bonus", rotulo: "Bônus atual", obrigatorio: false },
    ...PERGUNTAS_SEGFY_AUTO,
  ],
};

const ENDOSSO: Roteiro = {
  id: "endosso",
  titulo: "Endosso",
  descricao: "Coleta de dados para emissão de endosso.",
  campos: [
    { chave: "segurado", rotulo: "Segurado", obrigatorio: true },
    { chave: "corretor", rotulo: "Corretor", obrigatorio: false, dica: "Inferido do canal / operador" },
    { chave: "alteracao", rotulo: "Alteração solicitada", obrigatorio: true, dica: "Descrever em texto livre o que precisa mudar" },
    { chave: "utilizacao_veiculo", rotulo: "Utilização do veículo", obrigatorio: false, dica: "Apenas se a alteração envolver uso" },
    { chave: "seguradora", rotulo: "Seguradora", obrigatorio: true },
    { chave: "restituicao", rotulo: "Restituição", obrigatorio: false, dica: "Boolean + valor aproximado" },
  ],
};

const NAO_RENOVADO: Roteiro = {
  id: "nao_renovado",
  titulo: "Não renovado",
  descricao: "Cliente com apólice vencida — pesquisa de reativação.",
  campos: [
    { chave: "segurado", rotulo: "Segurado", obrigatorio: true },
    { chave: "corretor", rotulo: "Corretor", obrigatorio: false, dica: "Inferido do canal / operador" },
    { chave: "apolice_anterior", rotulo: "Apólice anterior", obrigatorio: true, dica: "Número da apólice vencida" },
    { chave: "seguradora_anterior", rotulo: "Seguradora anterior", obrigatorio: true },
    { chave: "interesse_regularizar", rotulo: "Quer reativar?", obrigatorio: true, dica: "Sim → vira renovação. Não → registrar recusa" },
  ],
};

/**
 * Roteiros do ramo AUTO (Segfy). Mantidos byte-a-byte (o contrato em
 * `roteiros.test.ts` e o front pinam estes campos). `ROTEIROS` é re-exportado
 * como alias para retrocompatibilidade de imports/testes existentes.
 */
const ROTEIROS_AUTO: Partial<Record<CategoriaConversa, Roteiro>> = {
  renovacao: RENOVACAO,
  seguro_novo: SEGURO_NOVO,
  endosso: ENDOSSO,
  nao_renovado: NAO_RENOVADO,
  // duvida/outro: sem roteiro estruturado.
};

/** @deprecated use `getRoteiro(categoria, ramo)`. Alias do ramo auto (back-compat). */
export const ROTEIROS: Partial<Record<CategoriaConversa, Roteiro>> = ROTEIROS_AUTO;

// ── Ramos não-auto (somente coleta; cotação não-automatizada) ──────────────
// Sem campos de veículo nem perguntas Segfy. Endosso/não-renovado são genéricos
// (independem do ramo). O conjunto é rascunho — confirmar com SME (premissa P6).

/** Campos comerciais comuns a todos os ramos não-auto. */
const COMUNS_NAO_AUTO: CampoRoteiro[] = [
  { chave: "segurado", rotulo: "Segurado", obrigatorio: true },
  { chave: "cpf", rotulo: "CPF", obrigatorio: true, dica: "Identificação do cliente. Reforce a LGPD." },
  { chave: "email", rotulo: "E-mail", obrigatorio: true },
  { chave: "telefone", rotulo: "Telefone", obrigatorio: false, dica: "Inferido do WhatsApp" },
  { chave: "cep", rotulo: "CEP", obrigatorio: true, dica: "Consulte (tool consultar_cep) e CONFIRME o logradouro." },
  { chave: "numero", rotulo: "Número", obrigatorio: true, dica: "Número do endereço." },
  { chave: "complemento", rotulo: "Complemento", obrigatorio: false, dica: "Pergunte sempre; aceite 'sem complemento'." },
  { chave: "corretor", rotulo: "Corretor", obrigatorio: false, dica: "Inferido do canal / operador" },
  { chave: "comissao", rotulo: "Comissão", obrigatorio: false },
];

const ESPECIFICOS_VIDA: CampoRoteiro[] = [
  { chave: "data_nascimento", rotulo: "Data de nascimento", obrigatorio: true },
  { chave: "profissao", rotulo: "Profissão", obrigatorio: true },
  { chave: "renda_mensal", rotulo: "Renda mensal", obrigatorio: false },
  { chave: "fumante", rotulo: "Fumante?", obrigatorio: false, dica: "sim/não" },
  { chave: "capital_segurado_desejado", rotulo: "Capital segurado desejado", obrigatorio: false },
  { chave: "beneficiarios", rotulo: "Beneficiários", obrigatorio: false, dica: "Nomes e parentesco" },
  { chave: "praticante_atividade_risco", rotulo: "Pratica atividade de risco?", obrigatorio: false, dica: "Ex.: mergulho, paraquedismo" },
  { chave: "peso", rotulo: "Peso (kg)", obrigatorio: false },
  { chave: "altura", rotulo: "Altura (cm)", obrigatorio: false },
  { chave: "doenca_preexistente", rotulo: "Doença preexistente?", obrigatorio: false },
];

const ESPECIFICOS_RESIDENCIAL: CampoRoteiro[] = [
  { chave: "tipo_imovel", rotulo: "Tipo de imóvel", obrigatorio: true, dica: "casa, apartamento, sobrado..." },
  { chave: "valor_imovel", rotulo: "Valor do imóvel", obrigatorio: false },
  { chave: "valor_conteudo", rotulo: "Valor do conteúdo", obrigatorio: false, dica: "Móveis, eletro, etc." },
  { chave: "area_m2", rotulo: "Área (m²)", obrigatorio: false },
  { chave: "uso", rotulo: "Uso do imóvel", obrigatorio: false, dica: "habitual, veraneio, alugado" },
  { chave: "tem_alarme", rotulo: "Tem alarme?", obrigatorio: false, dica: "sim/não" },
  { chave: "tem_portaria_24h", rotulo: "Portaria 24h?", obrigatorio: false, dica: "sim/não" },
  { chave: "tipo_construcao", rotulo: "Tipo de construção", obrigatorio: false, dica: "alvenaria, madeira, mista" },
  { chave: "coberturas_desejadas", rotulo: "Coberturas desejadas", obrigatorio: false },
];

const ESPECIFICOS_EMPRESARIAL: CampoRoteiro[] = [
  { chave: "cnpj", rotulo: "CNPJ", obrigatorio: true },
  { chave: "razao_social", rotulo: "Razão social", obrigatorio: true },
  { chave: "atividade_cnae", rotulo: "Atividade / CNAE", obrigatorio: false },
  { chave: "faturamento_anual", rotulo: "Faturamento anual", obrigatorio: false },
  { chave: "numero_funcionarios", rotulo: "Nº de funcionários", obrigatorio: false },
  { chave: "valor_patrimonio", rotulo: "Valor do patrimônio", obrigatorio: false },
  { chave: "valor_estoque", rotulo: "Valor do estoque", obrigatorio: false },
  { chave: "coberturas_desejadas", rotulo: "Coberturas desejadas", obrigatorio: false },
  { chave: "possui_brigada_incendio", rotulo: "Possui brigada de incêndio?", obrigatorio: false, dica: "sim/não" },
];

const ESPECIFICOS_SAUDE: CampoRoteiro[] = [
  { chave: "quantidade_vidas", rotulo: "Quantidade de vidas", obrigatorio: true },
  { chave: "faixas_etarias", rotulo: "Faixas etárias", obrigatorio: true, dica: "Idades dos beneficiários" },
  { chave: "tipo_plano", rotulo: "Tipo de plano", obrigatorio: false, dica: "individual, familiar, empresarial" },
  { chave: "acomodacao", rotulo: "Acomodação", obrigatorio: false, dica: "enfermaria ou apartamento" },
  { chave: "abrangencia", rotulo: "Abrangência", obrigatorio: false, dica: "municipal, estadual, nacional" },
  { chave: "coparticipacao", rotulo: "Coparticipação?", obrigatorio: false, dica: "sim/não" },
  { chave: "operadora_atual", rotulo: "Operadora atual", obrigatorio: false },
  { chave: "carencia_a_aproveitar", rotulo: "Carência a aproveitar?", obrigatorio: false },
];

/** Endosso genérico (independe do ramo): alteração sobre apólice existente. */
const ENDOSSO_GENERICO: Roteiro = {
  id: "endosso",
  titulo: "Endosso",
  descricao: "Coleta de dados para emissão de endosso.",
  campos: [
    { chave: "segurado", rotulo: "Segurado", obrigatorio: true },
    { chave: "corretor", rotulo: "Corretor", obrigatorio: false, dica: "Inferido do canal / operador" },
    { chave: "alteracao", rotulo: "Alteração solicitada", obrigatorio: true, dica: "Descrever em texto livre o que precisa mudar" },
    { chave: "seguradora", rotulo: "Seguradora", obrigatorio: true },
    { chave: "restituicao", rotulo: "Restituição", obrigatorio: false, dica: "Boolean + valor aproximado" },
  ],
};

/** Não-renovado genérico (independe do ramo). */
const NAO_RENOVADO_GENERICO: Roteiro = NAO_RENOVADO;

/** Monta o conjunto de roteiros de um ramo não-auto a partir dos campos específicos. */
function montarRoteirosNaoAuto(
  ramoTitulo: string,
  especificos: CampoRoteiro[],
): Partial<Record<CategoriaConversa, Roteiro>> {
  const novo: Roteiro = {
    id: "seguro_novo",
    titulo: `Seguro novo — ${ramoTitulo}`,
    descricao: `Coleta de dados para contratação de seguro ${ramoTitulo.toLowerCase()}.`,
    campos: [...COMUNS_NAO_AUTO, ...especificos],
  };
  const renovacao: Roteiro = {
    id: "renovacao",
    titulo: `Renovação — ${ramoTitulo}`,
    descricao: `Coleta de dados para renovação de seguro ${ramoTitulo.toLowerCase()}.`,
    campos: [...COMUNS_NAO_AUTO, ...especificos],
  };
  return {
    seguro_novo: novo,
    renovacao,
    endosso: ENDOSSO_GENERICO,
    nao_renovado: NAO_RENOVADO_GENERICO,
  };
}

/** Roteiros por ramo. `auto` mantém o conjunto Segfy intacto. */
export const ROTEIROS_POR_RAMO: Record<Ramo, Partial<Record<CategoriaConversa, Roteiro>>> = {
  auto: ROTEIROS_AUTO,
  vida: montarRoteirosNaoAuto("Vida", ESPECIFICOS_VIDA),
  residencial: montarRoteirosNaoAuto("Residencial", ESPECIFICOS_RESIDENCIAL),
  empresarial: montarRoteirosNaoAuto("Empresarial", ESPECIFICOS_EMPRESARIAL),
  saude: montarRoteirosNaoAuto("Saúde", ESPECIFICOS_SAUDE),
};

export function getRoteiro(
  categoria: CategoriaConversa | null | undefined,
  ramo: Ramo = RAMO_PADRAO,
): Roteiro | null {
  if (!categoria) return null;
  return ROTEIROS_POR_RAMO[ramo]?.[categoria] ?? null;
}

/** Categorias que têm roteiro estruturado (as configuráveis na tela). */
export const CATEGORIAS_COM_ROTEIRO: CategoriaConversa[] = [
  "renovacao",
  "seguro_novo",
  "endosso",
  "nao_renovado",
];

export interface CatalogoCategoria {
  id: CategoriaConversa;
  titulo: string;
  campos: CampoRoteiro[];
}

/**
 * Catálogo dos campos por categoria, para a tela do Admin escolher o que a Bia
 * pergunta. Fonte ÚNICA — o front consome daqui (não duplica em bot-scripts).
 * Inclui PERGUNTAS_SEGFY_AUTO (já embutidas em cada roteiro auto).
 */
export function getCatalogoCampos(ramo: Ramo = RAMO_PADRAO): CatalogoCategoria[] {
  const mapa = ROTEIROS_POR_RAMO[ramo] ?? ROTEIROS_AUTO;
  return CATEGORIAS_COM_ROTEIRO.flatMap((id) => {
    const r = mapa[id];
    return r ? [{ id, titulo: r.titulo, campos: r.campos }] : [];
  });
}

/** Campo extra (pergunta customizada do admin). A `chave` deve começar com `custom_`. */
export interface PerguntaCustom {
  id: string;
  chave: string;
  pergunta: string;
  dica?: string | null;
}

/**
 * Roteiro EFETIVO de uma linha: parte do roteiro da categoria, REMOVE os campos
 * OPCIONAIS cuja chave está em `excluidos` (obrigatórios nunca saem — Segfy/LGPD)
 * e ANEXA as perguntas customizadas como campos opcionais. Retorna null se a
 * categoria não tem roteiro.
 */
export function getRoteiroEfetivo(
  categoria: CategoriaConversa | null | undefined,
  excluidos: readonly string[] = [],
  custom: readonly PerguntaCustom[] = [],
  ramo: Ramo = RAMO_PADRAO,
): Roteiro | null {
  const base = getRoteiro(categoria, ramo);
  if (!base) return null;
  const fora = new Set(excluidos);
  const campos = base.campos.filter((c) => c.obrigatorio || !fora.has(c.chave));
  for (const q of custom) {
    if (!q.chave) continue;
    campos.push({ chave: q.chave, rotulo: q.pergunta, obrigatorio: false, dica: q.dica ?? undefined });
  }
  return { ...base, campos };
}

export function calcularProgresso(
  categoria: CategoriaConversa | null | undefined,
  dados: Record<string, unknown>,
  ramo: Ramo = RAMO_PADRAO,
): { preenchidos: number; total: number; pendentesObrigatorios: CampoRoteiro[]; completo: boolean } {
  const roteiro = getRoteiro(categoria, ramo);
  if (!roteiro) return { preenchidos: 0, total: 0, pendentesObrigatorios: [], completo: false };
  const obrig = roteiro.campos.filter((c) => c.obrigatorio);
  const preenchidos = obrig.filter((c) => dados[c.chave] != null && dados[c.chave] !== "").length;
  const pendentesObrigatorios = obrig.filter((c) => dados[c.chave] == null || dados[c.chave] === "");
  return { preenchidos, total: obrig.length, pendentesObrigatorios, completo: pendentesObrigatorios.length === 0 };
}

/**
 * Resumo dos dados JÁ CAPTURADOS de um cliente recorrente, para a Bia apresentar
 * "de uma vez" e perguntar se algo mudou (revisão). Usa o roteiro EFETIVO da linha
 * (respeita campos excluídos e perguntas customizadas do Admin) e lista APENAS os
 * campos do roteiro que estão preenchidos — chaves órfãs (ex.: `endereco` legado,
 * dados de outra categoria) ficam de fora. Função pura. Vazio = nada a revisar.
 */
export function montarResumoRevisao(
  categoria: CategoriaConversa | null | undefined,
  dados: Record<string, unknown>,
  excluidos: readonly string[] = [],
  custom: readonly PerguntaCustom[] = [],
  ramo: Ramo = RAMO_PADRAO,
): string[] {
  const roteiro = getRoteiroEfetivo(categoria, excluidos, custom, ramo);
  if (!roteiro) return [];
  const linhas: string[] = [];
  for (const c of roteiro.campos) {
    const v = dados[c.chave];
    if (v == null || v === "") continue;
    linhas.push(`- ${c.rotulo}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return linhas;
}

/**
 * Chaves preenchidas AUTOMATICAMENTE pela consulta de CEP (tool consultar_cep) —
 * não são perguntadas no roteiro, mas precisam passar pela whitelist para serem
 * persistidas. `endereco` permanece válido só por RETROCOMPATIBILIDADE (conversas
 * antigas + fallback manual no mapeamento Segfy).
 */
export const CHAVES_AUTO: ReadonlySet<string> = new Set([
  "logradouro",
  "bairro",
  "cidade",
  "uf",
  "endereco",
]);

/**
 * Chaves válidas de TODOS os roteiros de TODOS os ramos + auto-preenchidas
 * (whitelist do tool_use). É um SUPERSET: nenhuma chave do auto é removida, logo
 * sem regressão. O guard de merge por conversa (processarFormularioRecebido)
 * restringe ao roteiro do (categoria, ramo) da própria conversa, então chaves de
 * outro ramo não vazam para a conversa errada.
 */
export const CHAVES_VALIDAS: ReadonlySet<string> = new Set([
  ...Object.values(ROTEIROS_POR_RAMO)
    .flatMap((mapa) => Object.values(mapa))
    .filter((r): r is Roteiro => !!r)
    .flatMap((r) => r.campos.map((c) => c.chave)),
  ...CHAVES_AUTO,
]);
