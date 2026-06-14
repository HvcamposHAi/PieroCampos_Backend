/**
 * INFERÊNCIA do CATÁLOGO DE SEGUROS disponíveis no portal.
 *
 * Detecta ramos por (a) links/itens de menu do DOM e (b) caminhos no HAR. Nada é
 * hardcoded como "verdade do portal": o superset de referência só serve para
 * NORMALIZAR rótulos para slugs conhecidos do mercado BR — termos fora dele
 * viram slug livre (kebab) e entram como `nao_mapeado`.
 */
import type { HarResumo, Operacao, RamoDisponivel } from "../descoberta.types";
import { partesUrl } from "../descoberta.util";

/** Sinônimos → slug canônico do mercado BR (superset de referência). */
const SINONIMOS: { slug: string; re: RegExp }[] = [
  { slug: "auto", re: /\b(auto|autom[oó]vel|carro|ve[ií]culo|moto|frota|caminh[aã]o)\b/i },
  { slug: "residencial", re: /\b(residencial|resid[eê]ncia|casa|lar)\b/i },
  { slug: "condominio", re: /\bcond[oô]m[ií]nio\b/i },
  { slug: "empresarial", re: /\b(empresarial|empresa|patrimonial|pyme|pme)\b/i },
  { slug: "vida", re: /\bvida\b/i },
  { slug: "acidentes_pessoais", re: /\b(acidentes? pessoa|ap individual|\bap\b)\b/i },
  { slug: "prestamista", re: /\bprestamista\b/i },
  { slug: "saude", re: /\b(sa[uú]de|health)\b/i },
  { slug: "odontologico", re: /\b(odonto|dental)\b/i },
  { slug: "viagem", re: /\b(viagem|travel)\b/i },
  { slug: "responsabilidade_civil", re: /\b(responsabilidade civil|\brc\b|d&o|e&o)\b/i },
  { slug: "equipamentos", re: /\b(equipamentos?|riscos? de engenharia)\b/i },
  { slug: "garantia", re: /\bgarantia\b/i },
  { slug: "fianca_locaticia", re: /\b(fian[cç]a|locat[ií]cia)\b/i },
  { slug: "rural", re: /\b(rural|agro|agr[ií]cola|penhor)\b/i },
  { slug: "nautico", re: /\b(n[aá]utico|embarca[cç][aã]o)\b/i },
  { slug: "aeronautico", re: /\b(aeron[aá]utico|aeronave)\b/i },
  { slug: "transporte", re: /\b(transporte|cargas?|rctr-?c|rcf-?dc)\b/i },
  { slug: "previdencia", re: /\b(previd[eê]ncia|pgbl|vgbl)\b/i },
  { slug: "capitalizacao", re: /\bcapitaliza[cç][aã]o\b/i },
];

/** Normaliza um rótulo livre para slug canônico, ou kebab-case se desconhecido. */
export function normalizarRamoLivre(rotulo: string): { slug: string; conhecido: boolean } {
  for (const s of SINONIMOS) if (s.re.test(rotulo)) return { slug: s.slug, conhecido: true };
  const slug = rotulo
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return { slug: slug || "desconhecido", conhecido: false };
}

export interface DetectarRamosInput {
  har: HarResumo;
  /** ramos para os quais já existe fluxo suportado (ex.: ['auto']). */
  ramosSuportados?: string[];
  /** operação alvo da descoberta. */
  operacao?: Operacao;
}

export function detectarRamos(input: DetectarRamosInput): RamoDisponivel[] {
  const { har, ramosSuportados = [], operacao = "cotacao" } = input;
  const achados = new Map<string, RamoDisponivel>();

  const registrar = (rotulo: string): void => {
    const { slug, conhecido } = normalizarRamoLivre(rotulo);
    if (achados.has(slug)) return;
    const suportado = ramosSuportados.includes(slug);
    achados.set(slug, {
      ramo: slug,
      rotuloNoPortal: rotulo.trim(),
      operacoes: [operacao],
      statusSuporte: suportado ? "suportado" : conhecido ? "nao_mapeado" : "nao_mapeado",
    });
  };

  // (a) menu/links do DOM
  for (const link of har.domLinks ?? []) {
    if (SINONIMOS.some((s) => s.re.test(link.texto)) || /ramo|produto|seguro/i.test(link.href)) {
      registrar(link.texto || link.href);
    }
  }

  // (b) caminhos no HAR (ex.: /produtos/auto, /ramos/vida)
  for (const e of har.entradas) {
    const { pathname } = partesUrl(e.url);
    const m = pathname.match(/\/(?:ramos?|produtos?|seguros?)\/([a-z0-9_-]+)/i);
    const cap = m?.[1];
    if (cap) registrar(cap.replace(/[-_]/g, " "));
  }

  return [...achados.values()];
}
