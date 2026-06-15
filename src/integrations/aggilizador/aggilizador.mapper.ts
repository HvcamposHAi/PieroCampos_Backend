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
  // ── Overrides OPCIONAIS do questionário do veículo (cotação manual) ──────────
  // Ausentes → o motor usa DEFAULTS_AGGILIZADOR. Presentes → o operador ajustou.
  /** Código de combustível (sobrepõe o decodificado/default). */
  combustivel?: number;
  /** Quilometragem MENSAL (convertida p/ anual no payload). */
  kmMensal?: number;
  /** Garagem na residência ("1"=sim / "2"=não). */
  garagemResidencia?: string;
  /** Percentual da tabela FIPE a segurar (ex.: 100) → payload `pctAjuste`. */
  pctAjuste?: number;
  /** Comissão (%) efetiva da cotação (default da corretora, editável). */
  comissaoPercentual?: number;
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

/**
 * Combustível livre (texto ou código) → código do Aggilizador. Overrides do
 * operador; ausente/inválido → undefined (o motor usa DEFAULTS_AGGILIZADOR).
 * 🚨 VALIDAR-LIVE: confirmar os códigos no HAR.
 */
const MAP_COMBUSTIVEL_AGG: Record<string, number> = {
  flex: 11, // ✅ confirmado no HAR (SANDERO Hi-Flex → 11)
  // 🚨 VALIDAR-LIVE: demais códigos ainda não vistos no HAR (palpites).
  gasolina: 1,
  alcool: 2,
  etanol: 2,
  diesel: 3,
  hibrido: 5,
  eletrico: 6,
  gnv: 7,
};

function normalizarCombustivel(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  const s = asString(v)
    ?.toLowerCase()
    .replace(/[^a-z]/g, "");
  return s ? MAP_COMBUSTIVEL_AGG[s] : undefined;
}

/** Número positivo (km mensal etc.); undefined se ausente/inválido. */
function normalizarNumeroPositivo(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(asString(v));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Percentual FIPE (pctAjuste) 50–200; fora disso → undefined (usa default). */
function normalizarPctAjuste(v: unknown): number | undefined {
  const n = normalizarNumeroPositivo(v);
  return n != null && n >= 50 && n <= 200 ? n : undefined;
}

/** Comissão (%) 0–100; fora disso → undefined (cai no default da corretora). */
function normalizarComissao(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(asString(v));
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
}

/**
 * Telefone BR para o Aggilizador: só dígitos, SEM DDI. O HAR de sucesso usa
 * `fone1:"41996247863"` (DDD+nº). Remove o `55` líder quando o resto fica com
 * 10–11 dígitos (DDD+nº); preserva números já sem DDI. PURA.
 */
export function removerDdiBr(tel: unknown): string | undefined {
  const d = (asString(tel) ?? "").replace(/\D/g, "");
  if (!d) return undefined;
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) return d.slice(2);
  return d;
}

/** Garagem livre → "1" (sim) | "2" (não); undefined se indefinido. */
function normalizarGaragem(v: unknown): string | undefined {
  const s = asString(v)?.toLowerCase();
  if (!s) return undefined;
  if (s === "1" || s.startsWith("sim") || s.startsWith("possui")) return "1";
  if (s === "2" || s.startsWith("nao") || s.startsWith("não")) return "2";
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

  // O Aggilizador NÃO tem a API que preenche nome/nascimento/sexo do Segfy —
  // esses campos precisam ser coletados. Validamos aqui (espelha o roteiro do
  // Aggilizador) para a cotação dar uma mensagem ESPECÍFICA do que falta, em vez
  // de falhar fundo na etapa do segurado. Nome cai no cliente; nasc/sexo não.
  const dataNascimento = normalizarData(dados.data_nascimento);
  const sexo = normalizarSexo(dados.sexo);
  const faltandoAgg = [...faltando];
  if (!dataNascimento) faltandoAgg.push("data de nascimento");
  if (!sexo) faltandoAgg.push("sexo");
  if (faltandoAgg.length > 0 || !cpf || !placa || !cep) {
    return { entrada: null, faltando: faltandoAgg };
  }

  const estadoCivilKey = asString(dados.estado_civil)?.toLowerCase();
  const entrada: EntradaAggilizador = {
    cpf,
    placa,
    cep: cep.replace(/\D/g, ""),
    nome: asString(dados.nome) ?? cliente.nome ?? undefined,
    email: asString(dados.email) ?? cliente.email ?? undefined,
    // Aggilizador usa o telefone SEM DDI (HAR: "41996247863").
    telefone: removerDdiBr(asString(dados.telefone) ?? cliente.telefone),
    dataNascimento,
    sexo,
    estadoCivilCodigo: (estadoCivilKey && MAP_ESTADO_CIVIL_AGG[estadoCivilKey]) || ESTADO_CIVIL_DEFAULT,
    zeroKm: ehSim(dados.zero_km) === true,
    // Overrides opcionais do questionário (cotação manual); ausentes → defaults.
    combustivel: normalizarCombustivel(dados.combustivel),
    kmMensal: normalizarNumeroPositivo(dados.km_mes ?? dados.quilometragem_mensal),
    garagemResidencia: normalizarGaragem(dados.garagem ?? dados.garagem_residencia),
    pctAjuste: normalizarPctAjuste(dados.percentual_fipe ?? dados.perc_fipe),
    comissaoPercentual: normalizarComissao(dados.comissao_percentual ?? dados.comissao),
  };
  return { entrada, faltando: [] };
}
