/**
 * Emite um documento OpenAPI 3.1 (objeto JS) a partir dos endpoints inferidos +
 * análise de segurança. Inclui a extensão `x-preconditions` com as premissas do
 * processo (auth/2FA/captcha/CPF/etc.) — legível por humano E por máquina.
 */
import type { AnaliseSeguranca, CampoDescoberto, EndpointDescoberto, Premissa } from "../descoberta.types";

function jsonSchemaDeCampos(campos: CampoDescoberto[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const c of campos) {
    const prop: Record<string, unknown> = { type: c.tipo === "array" ? "array" : c.tipo === "object" ? "object" : c.tipo };
    if (c.pattern) prop.pattern = c.pattern;
    properties[c.nome] = prop;
    if (c.obrigatorio) required.push(c.nome);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

export interface MontarOpenApiInput {
  sistema: string;
  ramo: string;
  urlBase: string | null;
  endpoints: EndpointDescoberto[];
  seguranca: AnaliseSeguranca | Record<string, never>;
  premissas: Premissa[];
}

export function montarOpenApi(input: MontarOpenApiInput): Record<string, unknown> {
  const { sistema, ramo, urlBase, endpoints, seguranca, premissas } = input;
  const paths: Record<string, Record<string, unknown>> = {};

  for (const ep of endpoints) {
    const item = (paths[ep.pathTemplate] ??= {});
    const op: Record<string, unknown> = {
      summary: ep.papel ?? "endpoint",
      "x-confianca": ep.confianca,
    };
    if (ep.auth === "bearer") op.security = [{ BearerAuth: [] }];
    if (ep.metodo !== "GET" && ep.campos.length) {
      op.requestBody = {
        required: true,
        content: { "application/json": { schema: jsonSchemaDeCampos(ep.campos) } },
      };
    }
    op.responses = { "200": { description: "ok" } };
    item[ep.metodo.toLowerCase()] = op;
  }

  const seg = seguranca as AnaliseSeguranca;
  const preconditions: Record<string, unknown> = {
    auth_obrigatoria: true,
    auth_esquema: seg.auth?.esquema ?? "desconhecido",
    "2fa_required": seg.twoFactor?.presente ?? false,
    "2fa_metodo": seg.twoFactor?.metodo ?? null,
    captcha: seg.captcha?.presente ?? false,
    captcha_tipo: seg.captcha?.tipo ?? null,
    tls_em_tudo: seg.transporte?.tlsTudo ?? null,
    payload_cifrado: seg.criptografia?.payloadCifrado ?? false,
    cert_pinning: seg.criptografia?.certPinning ?? false,
    pii_trafegada: seg.piiTrafegada ?? [],
    premissas: premissas.map((p) => ({ chave: p.chave, valor: p.valor, confianca: p.confianca })),
  };

  return {
    openapi: "3.1.0",
    info: {
      title: `${sistema} — ${ramo} (descoberto)`,
      version: "1.0.0",
      description: `Contrato auto-descoberto pelo Agente Descobridor de Integrações (ADI).`,
      "x-discovery-method": "traffic-first (CDP/HAR) + LLM",
    },
    servers: urlBase ? [{ url: urlBase }] : [],
    "x-preconditions": preconditions,
    components: { securitySchemes: { BearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
    paths,
  };
}
