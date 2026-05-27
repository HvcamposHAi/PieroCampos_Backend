/**
 * Carga e validação das variáveis de ambiente (Zod).
 *
 * Validação é LAZY (`getEnv()` valida na primeira chamada e cacheia), de modo
 * que importar módulos puros (ex.: formatação) em testes não exija um .env.
 * Em produção (Render) as variáveis já existem no ambiente; localmente o
 * dotenv carrega o `.env`. Nunca logamos os valores (ver logger.redigir).
 */
import "dotenv/config";
import { z } from "zod";

const boolDeString = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const numComPadrao = (padrao: number) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === "") return padrao;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : padrao;
    });

const schema = z
  .object({
    SEGFY_ENABLED: boolDeString.default(false),
    SEGFY_LOGIN: z.string().optional().default(""),
    SEGFY_SENHA: z.string().optional().default(""),
    SEGFY_API_URL: z.string().url().optional().or(z.literal("")).default(""),
    SEGFY_APP_URL: z.string().url().default("https://app.segfy.com"),
    SEGFY_COTACAO_TIMEOUT_MS: numComPadrao(60_000),
    SEGFY_COTACAO_INTERVAL_MS: numComPadrao(3_000),
    SEGFY_HEADLESS: boolDeString.default(true),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    // Supabase — opcionais aqui (o módulo Segfy só os exige se o adapter
    // SupabasePersistence for usado; o InMemoryPersistence dispensa).
    SUPABASE_URL: z.string().url().optional().or(z.literal("")).default(""),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(""),
  })
  // Quando a integração está ligada, credenciais passam a ser obrigatórias.
  .superRefine((val, ctx) => {
    if (!val.SEGFY_ENABLED) return;
    if (!val.SEGFY_LOGIN) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["SEGFY_LOGIN"], message: "obrigatório quando SEGFY_ENABLED=true" });
    }
    if (!val.SEGFY_SENHA) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["SEGFY_SENHA"], message: "obrigatório quando SEGFY_ENABLED=true" });
    }
  });

export type Env = z.infer<typeof schema>;

let cache: Env | null = null;

export function getEnv(): Env {
  if (cache) return cache;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Mensagem sem valores — só nomes de campo e motivo.
    const motivos = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Configuração de ambiente inválida: ${motivos}`);
  }
  cache = parsed.data;
  return cache;
}

/** Reseta o cache (uso em testes). */
export function _resetEnvCache(): void {
  cache = null;
}
