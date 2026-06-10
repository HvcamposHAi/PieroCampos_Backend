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
    // Coleta de resultados do multicálculo: encerra após N ms SEM novo RESULT
    // (além do teto de 120s) — evita esperar 2min quando nem todas respondem.
    SEGFY_COLETA_OCIOSA_MS: numComPadrao(12_000),
    // Log verboso de cada evento STEP/RESULT do socket (diagnóstico). NUNCA loga PII.
    SEGFY_DEBUG_COLETA: boolDeString.default(false),
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
    // ── Geração de APÓLICE por seguradora (RPA por portal + API onde houver) ──
    // Gate MESTRE. default false = deploy INERTE: a rota /api/apolice/.../gerar
    // responde 409 `apolice_desabilitado` e NENHUM portal é tocado. Ligar só após
    // rodar as cláusulas de banco (seed seguradoras_config + seguradora_credenciais
    // + bucket apolices) e cadastrar credenciais por seguradora.
    APOLICE_ENABLED: boolDeString.default(false),
    // Gate do navegador (Playwright) da emissão/teste por portal. Espelha
    // SEGFY_SCRAPING_ENABLED: checado ANTES de chromium.launch. false = isola o
    // browser (emissão RPA e "Testar" de portal B_rpa/C_otp falham com erro
    // gracioso `apolice_rpa_desabilitado`); o caminho A_api (HTTP) não é afetado.
    APOLICE_RPA_ENABLED: boolDeString.default(false),
    APOLICE_HEADLESS: boolDeString.default(true),
    // Selector inerte (espelha SEGFY_TRANSPORT): 'rpa' | 'api' | 'off'. Não é lido
    // no runtime (o registry resolve por grupo_integracao); pronto p/ futuro toggle.
    APOLICE_TRANSPORT: z.enum(["rpa", "api", "off"]).default("off"),
    // Token compartilhado do AGENTE LOCAL de apólice (igual ao SEGFY_SESSAO_CRON_TOKEN):
    // o daemon na máquina do operador autentica com `x-cron-token` para pegar/reportar
    // jobs. Vazio → rotas do agente respondem 404 (desabilitadas). NO RENDER fica
    // `APOLICE_RPA_ENABLED=false` (servidor nunca sobe Chromium); o agente roda local
    // com `=true`. O navegador SAI do Render — corrige a causa-raiz do erro de Chromium.
    APOLICE_AGENT_TOKEN: z.string().optional().default(""),
    // Gate do driver de portal por LLM (adapta seletores ao layout/dados da página).
    // Espelha MAPPER_DINAMICO_ENABLED: efetivo = esta env E o toggle `portal_mapper_config`
    // (DB, por corretora). default false → FAIL-CLOSED nos seletores tolerantes atuais
    // (genericoDriver). Reusa ANTHROPIC_API_KEY + MAPPER_LLM_MODEL/MAPPER_LLM_MAX_TOKENS.
    PORTAL_MAPPER_ENABLED: boolDeString.default(false),
    // Aviso de reautenticação (2FA) ao operador. Número E.164 que recebe o alerta
    // por WhatsApp quando a sessão do Segfy expira; vazio = só notificação in-app.
    SEGFY_ALERTA_WPP_E164: z.string().optional().default(""),
    // Token do pinger externo p/ o aviso PROATIVO (POST /api/segfy/sessao/cron).
    // Vazio = endpoint desabilitado (404).
    SEGFY_SESSAO_CRON_TOKEN: z.string().optional().default(""),
    // Dias antes de expirar a sessão em que o aviso proativo dispara (default 3).
    SEGFY_AVISO_ANTECEDENCIA_DIAS: numComPadrao(3),
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
    // Aprendizado contínuo (playbook destilado). Reusa a mesma ANTHROPIC_API_KEY/
    // SDK da Bia (sem provedor externo de embeddings).
    // DEPRECADA (inerte): o liga/desliga migrou para o toggle do banco
    // `aprendizado_config` (controle do usuário na UI, ver lerAprendizadoAtivo).
    // Mantida no schema só para não quebrar deploys que ainda a setam; NÃO é mais
    // lida no gate de runtime.
    APRENDIZADO_ENABLED: boolDeString.default(false),
    // ── Mapeamento DINÂMICO de cotação (schema em DB + resolver LLM com cache) ──
    // Gate MESTRE. default false = deploy INERTE: `resolverEntrada` cai direto no
    // mapeamento HARDCODED de hoje (mapearParaCotacao) ANTES de qualquer leitura
    // de DB/LLM. Ligar só após rodar as cláusulas + o seed (npm run mapper:seed) e
    // ligar o toggle por-corretora no Admin. Efetivo = esta env E o toggle do DB.
    MAPPER_DINAMICO_ENABLED: boolDeString.default(false),
    // Modelo do resolver de campo (miss). Vazio → usa BIA_MODEL. Reusa ANTHROPIC_API_KEY.
    MAPPER_LLM_MODEL: z.string().optional().default(""),
    MAPPER_LLM_MAX_TOKENS: numComPadrao(256),
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
    // ── Copiloto: assistente de BI 360 no WhatsApp para o GESTOR/corretor ──
    // Gate MESTRE. default false = deploy INERTE: canais `tipo='gestor'` são
    // IGNORADOS no eventHandlers (nenhum desvio, nenhuma leitura nova) e o pipeline
    // do cliente segue idêntico. Ligar só após rodar as cláusulas (gestor_autorizado
    // + gestor_assist_config + gestor_conversas/mensagens) e cadastrar números na
    // allowlist. Efetivo por corretora = esta env E o toggle `gestor_assist_config.ativo`
    // (FAIL-CLOSED). Reusa ANTHROPIC_API_KEY/BIA_MODEL da Bia.
    GESTOR_ASSIST_ENABLED: boolDeString.default(false),
    // Modelo do Copiloto. Vazio → usa BIA_MODEL. Reusa ANTHROPIC_API_KEY.
    GESTOR_MODEL: z.string().optional().default(""),
    GESTOR_MAX_TOKENS: numComPadrao(1024),
    // Geração de GRÁFICOS do Copiloto (2º incremento, via Playwright). default false.
    // INERTE nesta fase: a tool de gráfico não é oferecida ao modelo enquanto off.
    GESTOR_GRAFICO_ENABLED: boolDeString.default(false),
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
