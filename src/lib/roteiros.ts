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
    { chave: "cep", rotulo: "CEP", obrigatorio: true, dica: "CEP onde o carro pernoita" },
  ],
};

const SEGURO_NOVO: Roteiro = {
  id: "seguro_novo",
  titulo: "Seguro novo",
  descricao: "Coleta de dados para contratação de seguro novo.",
  campos: [
    { chave: "segurado", rotulo: "Segurado", obrigatorio: true },
    { chave: "estado_civil", rotulo: "Estado civil", obrigatorio: true },
    { chave: "endereco", rotulo: "Endereço", obrigatorio: true, dica: "CEP + número" },
    { chave: "comissao", rotulo: "Comissão", obrigatorio: false },
    { chave: "utilizacao_veiculo", rotulo: "Utilização do veículo", obrigatorio: true },
    { chave: "email", rotulo: "E-mail", obrigatorio: true },
    { chave: "telefone_contato", rotulo: "Telefone de contato", obrigatorio: false, dica: "Inferido do WhatsApp" },
    { chave: "rg", rotulo: "RG", obrigatorio: true },
    { chave: "dados_veiculo_fipe", rotulo: "Dados do veículo (FIPE)", obrigatorio: true },
    { chave: "renovacao_outro_corretor", rotulo: "Vinha de outro corretor?", obrigatorio: false },
    { chave: "bonus", rotulo: "Bônus atual", obrigatorio: false },
  ],
};

const ENDOSSO: Roteiro = {
  id: "endosso",
  titulo: "Endosso",
  descricao: "Coleta de dados para emissão de endosso.",
  campos: [
    { chave: "segurado", rotulo: "Segurado", obrigatorio: true },
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
    { chave: "apolice_anterior", rotulo: "Apólice anterior", obrigatorio: true, dica: "Número da apólice vencida" },
    { chave: "seguradora_anterior", rotulo: "Seguradora anterior", obrigatorio: true },
    { chave: "interesse_regularizar", rotulo: "Quer reativar?", obrigatorio: true, dica: "Sim → vira renovação. Não → registrar recusa" },
  ],
};

export const ROTEIROS: Partial<Record<CategoriaConversa, Roteiro>> = {
  renovacao: RENOVACAO,
  seguro_novo: SEGURO_NOVO,
  endosso: ENDOSSO,
  nao_renovado: NAO_RENOVADO,
  // duvida/outro: sem roteiro estruturado.
};

export function getRoteiro(categoria: CategoriaConversa | null | undefined): Roteiro | null {
  if (!categoria) return null;
  return ROTEIROS[categoria] ?? null;
}

export function calcularProgresso(
  categoria: CategoriaConversa | null | undefined,
  dados: Record<string, unknown>,
): { preenchidos: number; total: number; pendentesObrigatorios: CampoRoteiro[]; completo: boolean } {
  const roteiro = getRoteiro(categoria);
  if (!roteiro) return { preenchidos: 0, total: 0, pendentesObrigatorios: [], completo: false };
  const obrig = roteiro.campos.filter((c) => c.obrigatorio);
  const preenchidos = obrig.filter((c) => dados[c.chave] != null && dados[c.chave] !== "").length;
  const pendentesObrigatorios = obrig.filter((c) => dados[c.chave] == null || dados[c.chave] === "");
  return { preenchidos, total: obrig.length, pendentesObrigatorios, completo: pendentesObrigatorios.length === 0 };
}

/** Chaves válidas de TODOS os roteiros (whitelist para validar o tool_use do Claude). */
export const CHAVES_VALIDAS: ReadonlySet<string> = new Set(
  Object.values(ROTEIROS)
    .filter((r): r is Roteiro => !!r)
    .flatMap((r) => r.campos.map((c) => c.chave)),
);
