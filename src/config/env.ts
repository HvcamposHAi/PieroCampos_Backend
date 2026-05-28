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
    // Supabase — agora obrigatório quando WA_ENABLED (ver superRefine).
    SUPABASE_URL: z.string().url().optional().or(z.literal("")).default(""),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(""),
    SUPABASE_ANON_KEY: z.string().optional().default(""),
    // WhatsApp (Baileys).
    WA_ENABLED: boolDeString.default(true),
    WA_AUTH_ENCRYPTION_KEY: z.string().optional().default(""),
    WA_RECONNECT_BACKOFF_MS: numComPadrao(5_000),
    WA_QR_TTL_MS: numComPadrao(60_000),
    // Agente conversacional Bia (Claude).
    BIA_ENABLED: boolDeString.default(true),
    ANTHROPIC_API_KEY: z.string().optional().default(""),
    BIA_MODEL: z.string().default("claude-sonnet-4-5-20250929"),
    BIA_MAX_TOKENS: numComPadrao(1024),
    // HTTP.
    PORT: numComPadrao(3000),
    FRONT_ORIGIN: z.string().optional().default(""),
  })
  // Quando integrações estão ligadas, credenciais passam a ser obrigatórias.
  .superRefine((val, ctx) => {
    if (val.SEGFY_ENABLED) {
      if (!val.SEGFY_LOGIN) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["SEGFY_LOGIN"], message: "obrigatório quando SEGFY_ENABLED=true" });
      }
      if (!val.SEGFY_SENHA) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["SEGFY_SENHA"], message: "obrigatório quando SEGFY_ENABLED=true" });
      }
    }
    if (val.WA_ENABLED) {
      if (!val.SUPABASE_URL) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["SUPABASE_URL"], message: "obrigatório quando WA_ENABLED=true" });
      }
      if (!val.SUPABASE_SERVICE_ROLE_KEY) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["SUPABASE_SERVICE_ROLE_KEY"], message: "obrigatório quando WA_ENABLED=true" });
      }
      if (!val.SUPABASE_ANON_KEY) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["SUPABASE_ANON_KEY"], message: "obrigatório quando WA_ENABLED=true (validação do JWT do front)" });
      }
      // 32 bytes em base64 = 44 chars (sem padding) ou 44 com '='. Aceitamos 43-44.
      if (!val.WA_AUTH_ENCRYPTION_KEY || val.WA_AUTH_ENCRYPTION_KEY.length < 43) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["WA_AUTH_ENCRYPTION_KEY"],
          message: "obrigatório quando WA_ENABLED=true; deve ser 32 bytes em base64 (use: openssl rand -base64 32)",
        });
      }
    }
    if (val.BIA_ENABLED) {
      if (!val.ANTHROPIC_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ANTHROPIC_API_KEY"],
          message: "obrigatório quando BIA_ENABLED=true (chave da Anthropic — Claude Sonnet)",
        });
      }
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
