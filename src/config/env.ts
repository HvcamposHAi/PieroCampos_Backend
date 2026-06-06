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
    // Transporte da integração Segfy. 'http-reverse' (default) = engenharia
    // reversa dos endpoints internos usada hoje (segfy.multicalculo.ts); 'oficial'
    // = API comercial documentada (ainda SEM credenciais — só o CONTRATO existe,
    // ver integrations/segfy/oficial/); 'off' = nenhuma. INERTE nesta fase: não é
    // lido no runtime de cotação (o registry mantém o caminho atual); existe como
    // configuração pronta para o selector futuro quando houver provider oficial.
    SEGFY_TRANSPORT: z.enum(["http-reverse", "oficial", "off"]).default("http-reverse"),
    // Gate do scraping (Playwright). default true = comportamento atual (reauth
    // assistida de 2FA funcionando). false = isola o navegador: a reauth assistida
    // e a sessão legada falham com erro gracioso e o operador usa "Importar sessão"
    // (cookie) — o contorno de 2FA SEM browser. NÃO afeta o login HTTP da cotação.
    SEGFY_SCRAPING_ENABLED: boolDeString.default(true),
    // Gmail OTP (fallback de 2FA Segfy a partir de 01/06/2026). Opcionais: o
    // caminho primário é um usuário de serviço isento de 2FA. Quando ausentes,
    // buscarOTPSegfy() lança erro claro e o scraper não tenta o desafio.
    GMAIL_CLIENT_ID: z.string().optional().default(""),
    GMAIL_CLIENT_SECRET: z.string().optional().default(""),
    GMAIL_REFRESH_TOKEN_PIERO: z.string().optional().default(""),
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
    // Aprendizado contínuo (playbook destilado). Desligado por padrão: enquanto
    // false, nada novo roda em runtime e a Bia se comporta como hoje. Reusa a
    // mesma ANTHROPIC_API_KEY/SDK da Bia (sem provedor externo de embeddings).
    APRENDIZADO_ENABLED: boolDeString.default(false),
    // Modelo do destilador (offline). Default = mesmo da Bia.
    APRENDIZADO_MODEL: z.string().default("claude-sonnet-4-5-20250929"),
    APRENDIZADO_MAX_TOKENS: numComPadrao(2048),
    // Token compartilhado p/ o endpoint /api/aprendizado/cron (pinger externo).
    // Vazio → endpoint cron desabilitado (só o botão do Admin dispara).
    APRENDIZADO_CRON_TOKEN: z.string().optional().default(""),
    // Transcrição de notas de voz (STT). Desligado por padrão: enquanto false,
    // áudio sem caption é ignorado como hoje (zero HTTP / zero escrita nova). O
    // Claude NÃO transcreve áudio (Messages API só aceita texto/imagem), por isso
    // usamos um provedor dedicado. `local` é um slot reservado p/ um futuro
    // microserviço whisper.cpp próprio (troca por env, sem mexer no código).
    TRANSCRICAO_ENABLED: boolDeString.default(false),
    TRANSCRICAO_PROVIDER: z.enum(["openai", "groq", "local"]).default("openai"),
    TRANSCRICAO_API_KEY: z.string().optional().default(""),
    TRANSCRICAO_MODEL: z.string().default("gpt-4o-mini-transcribe"),
    TRANSCRICAO_MAX_SEG: numComPadrao(300),
    TRANSCRICAO_MAX_BYTES: numComPadrao(25 * 1024 * 1024),
    TRANSCRICAO_TIMEOUT_MS: numComPadrao(30_000),
    // Multi-tenant (SaaS). Corretora "seed" (Piero de Campos) — uuid LITERAL fixo
    // usado no backfill, nos defaults de persistência e nos testes. Deve casar com
    // a linha semeada na migração `corretoras`. Não trocar sem re-backfillar.
    CORRETORA_SEED_ID: z.string().uuid().optional().default("00000000-0000-0000-0000-000000000001"),
    // HTTP.
    PORT: numComPadrao(3000),
    FRONT_ORIGIN: z.string().optional().default(""),
  })
  // Quando integrações estão ligadas, credenciais passam a ser obrigatórias.
  .superRefine((val, ctx) => {
    // SEGFY_LOGIN/SEGFY_SENHA NÃO são mais obrigatórios quando SEGFY_ENABLED=true:
    // as credenciais agora podem vir da tabela `segfy_credenciais` (Admin > Segfy);
    // o .env permanece apenas como fallback. Ver segfy-credenciais.service.ts.
    void val;
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
    if (val.TRANSCRICAO_ENABLED && !val.TRANSCRICAO_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TRANSCRICAO_API_KEY"],
        message: "obrigatório quando TRANSCRICAO_ENABLED=true (chave do provedor de transcrição)",
      });
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
