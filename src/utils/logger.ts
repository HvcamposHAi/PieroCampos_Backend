/**
 * Logger estruturado com redação de segredos.
 *
 * Sem dependências externas: escreve JSON em uma linha no stdout/stderr.
 * Qualquer chave sensível (token, senha, authorization, ...) é substituída
 * por "[REDACTED]" recursivamente antes de serializar — nunca logamos
 * credenciais nem tokens (requisito de segurança da integração Segfy).
 */

type Nivel = "debug" | "info" | "warn" | "error";

const ORDEM: Record<Nivel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function nivelAtual(): Nivel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error"
    ? raw
    : "info";
}

/** Fragmentos de chave que indicam dado sensível (case-insensitive). */
const CHAVES_SENSIVEIS = [
  "authorization",
  "password",
  "senha",
  "token",
  "refresh_token",
  "access_token",
  "secret",
  "service_role",
  "apikey",
  "api_key",
  "cookie",
  "set-cookie",
  "viewstate",
  // WhatsApp / Baileys: QR e creds (qualquer profundidade do payload de auth_state).
  "qr",
  "qr_code",
  "qrcode",
  "creds",
  "noisekey",
  "signedidentitykey",
  "signedprekey",
  "advsecret",
  "wa_auth_encryption_key",
  "encryption_key",
];

const REDACTED = "[REDACTED]";

function chaveEhSensivel(chave: string): boolean {
  const c = chave.toLowerCase();
  return CHAVES_SENSIVEIS.some((frag) => c.includes(frag));
}

/** Clona o valor redigindo qualquer campo sensível, em qualquer profundidade. */
export function redigir(valor: unknown, vistos = new WeakSet<object>()): unknown {
  if (valor === null || typeof valor !== "object") return valor;
  if (vistos.has(valor as object)) return "[Circular]";
  vistos.add(valor as object);

  if (Array.isArray(valor)) return valor.map((v) => redigir(v, vistos));

  const saida: Record<string, unknown> = {};
  for (const [chave, v] of Object.entries(valor as Record<string, unknown>)) {
    saida[chave] = chaveEhSensivel(chave) ? REDACTED : redigir(v, vistos);
  }
  return saida;
}

function emitir(nivel: Nivel, msg: string, meta?: Record<string, unknown>): void {
  if (ORDEM[nivel] < ORDEM[nivelAtual()]) return;

  const linha: Record<string, unknown> = {
    ts: new Date().toISOString(),
    nivel,
    msg,
  };
  if (meta && Object.keys(meta).length > 0) {
    linha.meta = redigir(meta);
  }

  const texto = JSON.stringify(linha);
  if (nivel === "error" || nivel === "warn") process.stderr.write(texto + "\n");
  else process.stdout.write(texto + "\n");
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emitir("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emitir("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emitir("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emitir("error", msg, meta),
};

export type Logger = typeof logger;
