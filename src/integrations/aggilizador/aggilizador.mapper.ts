/**
 * Mapeamento `dados_coletados` (Bia) + cliente → entrada do Aggilizador. PURO.
 *
 * Reusa `extrairObrigatorios` do mapper legado para que a crítica de cpf/placa/cep
 * (e o `faltando[]`) seja IDÊNTICA à do Segfy — o cliente que coleta os dados não
 * muda por sistema. Os lookups de endereço (CEP), veículo (placa→FIPE) e o
 * pré-cadastro do segurado (CPF) acontecem no `cotarAuto` (o motor do Aggilizador
 * resolve isso via API), então aqui só extraímos os campos crus + enums.
 *
 * Mantido FORA do mapper dinâmico de propósito: o schema dinâmico
 * (`provider='aggilizador'`) ainda não foi semeado, e a entrada do Aggilizador
 * tem forma própria. Quando/se o dinâmico cobrir o Aggilizador, este mapa vira o
 * fallback FAIL-CLOSED (mesmo papel do `legacy.mapearParaCotacao` no Segfy).
 */
import { asString, ehSim, extrairObrigatorios } from "../quote/mapper/legacy";

/** Entrada mínima do Aggilizador (o motor resolve endereço/veículo via API). */
export interface EntradaAggilizador {
  cpf: string;
  placa: string;
  cep: string;
  nome?: string;
  email?: string;
  telefone?: string;
  /** YYYY-MM-DD, quando coletado (senão o cadastro do Aggilizador preenche). */
  dataNascimento?: string;
  /** "M" | "F", quando coletado. */
  sexo?: string;
  /** Código numérico de estado civil do Aggilizador (default 3 = outros). */
  estadoCivilCodigo: number;
  zeroKm: boolean;
}

export interface EntradaMapeadaAggilizador {
  entrada: EntradaAggilizador | null;
  faltando: string[];
}

/**
 * Estado civil PT → código numérico do Aggilizador.
 * ⚠️ VALIDAR-LIVE: domínio observado parcialmente (3 = "outros" nos dados de
 * teste). Confirmar a tabela completa (Aggilizador/Multicálculo) numa cotação
 * real; o default 3 é o valor neutro observado.
 */
export const MAP_ESTADO_CIVIL_AGG: Record<string, number> = {
  solteiro: 1,
  casado: 2,
  uniao_estavel: 2,
  divorciado: 3,
  separado: 3,
  viuvo: 3,
};
const ESTADO_CIVIL_DEFAULT = 3;

/** Normaliza sexo livre → "M" | "F" (undefined se indefinido). */
function normalizarSexo(v: unknown): string | undefined {
  const s = asString(v)?.toLowerCase();
  if (!s) return undefined;
  if (s.startsWith("m")) return "M";
  if (s.startsWith("f")) return "F";
  return undefined;
}

/** Data de nascimento → YYYY-MM-DD (aceita ISO ou dd/mm/aaaa). */
function normalizarData(v: unknown): string | undefined {
  const s = asString(v);
  if (!s) return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return undefined;
}

export function mapearParaCotacaoAggilizador(
  dados: Record<string, unknown>,
  cliente: { cpf: string | null; nome?: string | null; email?: string | null; telefone?: string | null },
): EntradaMapeadaAggilizador {
  const { cpf, placa, cep, faltando } = extrairObrigatorios(dados, cliente);
  if (faltando.length > 0 || !cpf || !placa || !cep) return { entrada: null, faltando };

  const estadoCivilKey = asString(dados.estado_civil)?.toLowerCase();
  const entrada: EntradaAggilizador = {
    cpf,
    placa,
    cep: cep.replace(/\D/g, ""),
    nome: asString(dados.nome) ?? cliente.nome ?? undefined,
    email: asString(dados.email) ?? cliente.email ?? undefined,
    telefone: (asString(dados.telefone) ?? cliente.telefone ?? "").replace(/\D/g, "") || undefined,
    dataNascimento: normalizarData(dados.data_nascimento),
    sexo: normalizarSexo(dados.sexo),
    estadoCivilCodigo: (estadoCivilKey && MAP_ESTADO_CIVIL_AGG[estadoCivilKey]) || ESTADO_CIVIL_DEFAULT,
    zeroKm: ehSim(dados.zero_km) === true,
  };
  return { entrada, faltando: [] };
}
