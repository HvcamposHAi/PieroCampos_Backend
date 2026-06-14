/**
 * Utilitários PUROS do módulo descoberta — sem I/O, sem `eval`.
 *  - `lerCaminho`: JSONPath simples "a.b.c" (e "a.0.b") tolerante a ausências.
 *  - `aplicarTemplate`: resolve "{{a.b}}" a partir de um contexto (sem eval).
 *  - `redigir*`: remove segredos/PII de headers e corpos antes de persistir.
 *  - `templatizarPath`: /users/123 → /users/{id} (heurística de path-templating).
 */

/** Lê um caminho "a.b.0.c" de um objeto/array; retorna undefined se faltar. */
export function lerCaminho(raiz: unknown, caminho: string): unknown {
  if (!caminho) return raiz;
  const partes = caminho.split(".");
  let atual: unknown = raiz;
  for (const p of partes) {
    if (atual == null) return undefined;
    if (Array.isArray(atual)) {
      const idx = Number(p);
      if (!Number.isInteger(idx)) return undefined;
      atual = atual[idx];
    } else if (typeof atual === "object") {
      atual = (atual as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return atual;
}

/** Resolve "{{caminho}}" dentro de uma string a partir do contexto. */
export function aplicarTemplate(tpl: string, ctx: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, cam: string) => {
    const v = lerCaminho(ctx, cam);
    return v == null ? "" : String(v);
  });
}

/** Resolve um objeto de templates (cada valor é um template). */
export function aplicarTemplateObj(
  obj: Record<string, string> | undefined,
  ctx: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!obj) return out;
  for (const [k, v] of Object.entries(obj)) out[k] = aplicarTemplate(v, ctx);
  return out;
}

const HEADERS_SENSIVEIS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "proxy-authorization",
  "x-auth-token",
]);

/** Redige headers sensíveis (Authorization/Cookie/…) → "[REDACTED]". */
export function redigirHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const [k, v] of Object.entries(h)) {
    out[k] = HEADERS_SENSIVEIS.has(k.toLowerCase()) ? "[REDACTED]" : v;
  }
  return out;
}

/** Chaves de corpo que devem ser redigidas (PII/segredo) por nome. */
const CHAVES_PII = /(senha|password|token|secret|cpf|cnpj|rg|nascimento|email|telefone|celular|cartao|card)/i;

/** Redige recursivamente valores cujas chaves casem PII/segredo. Preserva forma. */
export function redigirCorpo(valor: unknown, profundidade = 0): unknown {
  if (profundidade > 8) return "[...]";
  if (Array.isArray(valor)) return valor.map((v) => redigirCorpo(v, profundidade + 1));
  if (valor && typeof valor === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      out[k] = CHAVES_PII.test(k) ? "[REDACTED]" : redigirCorpo(v, profundidade + 1);
    }
    return out;
  }
  return valor;
}

/** Coleta os NOMES de chaves que casam PII (para registrar piiTrafegada). */
export function coletarPii(valor: unknown, achados = new Set<string>(), prof = 0): Set<string> {
  if (prof > 8 || valor == null) return achados;
  if (Array.isArray(valor)) {
    for (const v of valor) coletarPii(v, achados, prof + 1);
    return achados;
  }
  if (typeof valor === "object") {
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      if (CHAVES_PII.test(k)) achados.add(k.toLowerCase());
      coletarPii(v, achados, prof + 1);
    }
  }
  return achados;
}

/**
 * Heurística de path-templating: substitui segmentos que parecem IDs por {id}.
 * Cobre números puros, UUIDs e tokens longos hex/base64. Espelha har2openapi.
 */
export function templatizarPath(pathname: string): string {
  const ehId = (seg: string): boolean => {
    if (/^\d+$/.test(seg)) return true; // 123
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true; // uuid
    if (/^[0-9a-f]{24,}$/i.test(seg)) return true; // hash/objectid longo
    return false;
  };
  return pathname
    .split("/")
    .map((seg) => (ehId(seg) ? "{id}" : seg))
    .join("/");
}

/** Extrai pathname + origin de uma URL (tolerante). */
export function partesUrl(url: string): { origin: string; pathname: string } {
  try {
    const u = new URL(url);
    return { origin: u.origin, pathname: u.pathname };
  } catch {
    return { origin: "", pathname: url };
  }
}
