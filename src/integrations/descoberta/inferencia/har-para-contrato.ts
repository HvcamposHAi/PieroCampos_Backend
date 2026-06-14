/**
 * INFERÊNCIA: HAR (resumido/redigido) → endpoints + campos + fluxo.
 *
 * Heurística determinística (estilo har2openapi/Traffic2OpenAPI): agrupa por
 * (método, path-templatizado), infere obrigatoriedade por frequência, detecta
 * auth por header, e classifica o PAPEL de cada endpoint (auth/criar/calcular/
 * poll/resultado). É PURA — a parte que precisa de julgamento (premissas finas,
 * enums) fica no `premissas.llm.ts`. Confiança = frequência observada.
 */
import type {
  CampoDescoberto,
  EndpointDescoberto,
  EtapaFluxo,
  HarResumo,
} from "../descoberta.types";
import { lerCaminho, partesUrl, templatizarPath } from "../descoberta.util";

function tipoDe(v: unknown): CampoDescoberto["tipo"] {
  if (Array.isArray(v)) return "array";
  if (v === null) return "string";
  switch (typeof v) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "string";
  }
}

const RE_CPF = /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/;
const RE_PLACA = /^[A-Z]{3}-?\d[A-Z0-9]\d{2}$/i;
const RE_CEP = /^\d{5}-?\d{3}$/;

function patternDe(nome: string, valor: unknown): string | undefined {
  const s = typeof valor === "string" ? valor : "";
  if (/cpf/i.test(nome) || RE_CPF.test(s)) return "^\\d{3}\\.?\\d{3}\\.?\\d{3}-?\\d{2}$";
  if (/placa/i.test(nome) || RE_PLACA.test(s)) return "^[A-Za-z]{3}-?\\d[A-Za-z0-9]\\d{2}$";
  if (/cep/i.test(nome) || RE_CEP.test(s)) return "^\\d{5}-?\\d{3}$";
  return undefined;
}

function authDeHeaders(h: Record<string, string>): EndpointDescoberto["auth"] {
  const keys = Object.keys(h).map((k) => k.toLowerCase());
  if (keys.includes("authorization")) return "bearer";
  if (keys.includes("cookie")) return "cookie";
  return "none";
}

function papelDe(metodo: string, path: string, respChaves: string[]): EndpointDescoberto["papel"] {
  const p = path.toLowerCase();
  if (/login|auth|token|signin|sessao|pdocs/.test(p)) return "auth";
  if (/ramos?|produtos?|catalog|config|seguradora/.test(p)) return "catalogo";
  if (/calcul|cotacao|quote|simul/.test(p) && metodo !== "GET") return "calcular";
  if (metodo === "GET" && /calcul|cotacao|status|resultado|quote/.test(p)) return "poll";
  if (respChaves.some((c) => /resultado|premio|oferta|cotad/i.test(c))) return "resultado";
  if (metodo === "POST" && /cliente|segurado|cadastro|create/.test(p)) return "criar";
  return "outro";
}

/** Mescla os campos observados em várias ocorrências do mesmo endpoint. */
function mesclarCampos(corpos: unknown[]): CampoDescoberto[] {
  const total = corpos.length || 1;
  const cont = new Map<string, { tipo: CampoDescoberto["tipo"]; vezes: number; exemplo: unknown; nome: string }>();
  for (const corpo of corpos) {
    if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) continue;
    for (const [k, v] of Object.entries(corpo as Record<string, unknown>)) {
      const cur = cont.get(k) ?? { tipo: tipoDe(v), vezes: 0, exemplo: v, nome: k };
      cur.vezes += 1;
      cont.set(k, cur);
    }
  }
  return [...cont.values()].map((c) => ({
    nome: c.nome,
    tipo: c.tipo,
    // obrigatório = apareceu em TODAS as ocorrências observadas
    obrigatorio: c.vezes >= total,
    pattern: patternDe(c.nome, c.exemplo),
    confianca: c.vezes / total,
  }));
}

export interface ContratoInferido {
  urlBase: string | null;
  endpoints: EndpointDescoberto[];
  fluxo: EtapaFluxo[];
}

/**
 * Infere endpoints e fluxo a partir do HAR resumido. Ignora estáticos
 * (js/css/img/fontes) e respostas de erro de auth (status>=400) para o fluxo.
 */
export function inferirContrato(har: HarResumo): ContratoInferido {
  const ESTATICO = /\.(js|css|png|jpe?g|svg|gif|woff2?|ico|map)(\?|$)/i;
  const apiEntradas = har.entradas.filter((e) => !ESTATICO.test(e.url));

  // agrupa por (método, origin+pathTemplate)
  const grupos = new Map<
    string,
    { metodo: string; origin: string; pathTemplate: string; reqHeaders: Record<string, string>; corpos: unknown[]; respChaves: Set<string>; vezes: number; primeiroIdx: number }
  >();

  apiEntradas.forEach((e, idx) => {
    const { origin, pathname } = partesUrl(e.url);
    const pathTemplate = templatizarPath(pathname);
    const chave = `${e.metodo} ${origin}${pathTemplate}`;
    const g = grupos.get(chave) ?? {
      metodo: e.metodo,
      origin,
      pathTemplate,
      reqHeaders: e.reqHeaders ?? {},
      corpos: [] as unknown[],
      respChaves: new Set<string>(),
      vezes: 0,
      primeiroIdx: idx,
    };
    g.vezes += 1;
    if (e.reqBody !== undefined) g.corpos.push(e.reqBody);
    if (e.respBody && typeof e.respBody === "object" && !Array.isArray(e.respBody)) {
      for (const k of Object.keys(e.respBody as Record<string, unknown>)) g.respChaves.add(k);
    }
    grupos.set(chave, g);
  });

  const origens = new Map<string, number>();
  const endpoints: EndpointDescoberto[] = [...grupos.values()]
    .sort((a, b) => a.primeiroIdx - b.primeiroIdx)
    .map((g) => {
      origens.set(g.origin, (origens.get(g.origin) ?? 0) + g.vezes);
      const respChaves = [...g.respChaves];
      return {
        metodo: g.metodo as EndpointDescoberto["metodo"],
        pathTemplate: g.pathTemplate,
        urlBase: g.origin,
        auth: authDeHeaders(g.reqHeaders),
        campos: mesclarCampos(g.corpos),
        respostaChaves: respChaves,
        papel: papelDe(g.metodo, g.pathTemplate, respChaves),
        confianca: Math.min(1, g.vezes / Math.max(1, apiEntradas.length > 1 ? 1 : 1)),
      } satisfies EndpointDescoberto;
    });

  // urlBase = origin de API mais frequente
  let urlBase: string | null = null;
  let max = -1;
  for (const [orig, n] of origens) {
    if (orig && n > max) {
      max = n;
      urlBase = orig;
    }
  }

  // fluxo = ordem de primeira aparição dos endpoints com papel relevante
  const ordemPapel: Record<string, number> = { auth: 0, criar: 1, catalogo: 1, calcular: 2, poll: 3, resultado: 4, outro: 9 };
  const fluxo: EtapaFluxo[] = endpoints
    .filter((e) => e.papel && e.papel !== "outro")
    .sort((a, b) => (ordemPapel[a.papel ?? "outro"] ?? 9) - (ordemPapel[b.papel ?? "outro"] ?? 9))
    .map((e, i) => ({
      ordem: i + 1,
      nome: e.papel ?? "outro",
      endpointPath: `${e.metodo} ${e.pathTemplate}`,
      descricao: undefined,
    }));

  return { urlBase, endpoints, fluxo };
}

/** Atalho usado nos testes / serviço: só os endpoints. */
export function inferirEndpoints(har: HarResumo): EndpointDescoberto[] {
  return inferirContrato(har).endpoints;
}

/** Conveniência: lê um valor de resposta por caminho (reexport leve). */
export const lerRespostaCaminho = lerCaminho;
