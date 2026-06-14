/**
 * INFERÊNCIA de SEGURANÇA (premissa do processo): captcha, TLS/criptografia,
 * esquema de auth (login+senha SEMPRE obrigatório) e PII trafegada.
 *
 * PURA: recebe o HAR resumido + sinais de DOM (strings de scripts/markup) e
 * devolve `AnaliseSeguranca`. Conservadora: na dúvida marca presença/risco
 * (FAIL-SAFE — preferimos exigir humano a burlar proteção).
 */
import type { AnaliseSeguranca, HarResumo, TipoCaptcha } from "../descoberta.types";
import { coletarPii, partesUrl } from "../descoberta.util";

const SINAIS_CAPTCHA: { re: RegExp; tipo: TipoCaptcha }[] = [
  { re: /recaptcha\/api\.js|g-recaptcha|grecaptcha\.execute/i, tipo: "recaptcha_v3" },
  { re: /g-recaptcha|recaptcha\/api2/i, tipo: "recaptcha_v2" },
  { re: /hcaptcha\.com|h-captcha/i, tipo: "hcaptcha" },
  { re: /challenges\.cloudflare\.com|turnstile|cf-turnstile/i, tipo: "turnstile" },
  { re: /name=["']?(honeypot|website|url_extra)["']?[^>]*style=["'][^"']*display\s*:\s*none/i, tipo: "honeypot" },
];

const RE_2FA = /\b(otp|mfa|2fa|two[\s-]?factor|c[oó]digo de verifica|autentica[cç][aã]o de dois)\b/i;
const RE_LOGIN_FORM = /type=["']?password["']?|name=["']?(senha|password|pwd)["']?/i;

export interface SinaisDom {
  /** HTML/scripts concatenados (já sem PII de usuário). */
  markup?: string;
  /** true se a sessão observada exigiu OTP/2FA durante a captura. */
  exigiu2fa?: boolean;
}

export function analisarSeguranca(har: HarResumo, dom: SinaisDom = {}): AnaliseSeguranca {
  const markup = dom.markup ?? "";

  // ── transporte / TLS ──
  const httpPuroEm: string[] = [];
  for (const e of har.entradas) {
    const { origin } = partesUrl(e.url);
    if (origin.startsWith("http://") && !httpPuroEm.includes(origin)) httpPuroEm.push(origin);
  }
  const tlsTudo = httpPuroEm.length === 0;

  // ── auth ──
  const temBearer = har.entradas.some((e) =>
    Object.keys(e.reqHeaders ?? {}).some((k) => k.toLowerCase() === "authorization"),
  );
  const temCookie = har.entradas.some((e) =>
    Object.keys(e.reqHeaders ?? {}).some((k) => k.toLowerCase() === "cookie"),
  );
  const temForm = RE_LOGIN_FORM.test(markup);
  const esquema: AnaliseSeguranca["auth"]["esquema"] = temBearer
    ? "bearer_jwt"
    : temCookie
      ? "cookie_sessao"
      : temForm
        ? "form_login"
        : "desconhecido";

  // ── 2FA ──
  const presente2fa = Boolean(dom.exigiu2fa) || RE_2FA.test(markup);

  // ── captcha ──
  let captcha: AnaliseSeguranca["captcha"] = { presente: false };
  for (const s of SINAIS_CAPTCHA) {
    if (s.re.test(markup)) {
      captcha = { presente: true, tipo: s.tipo, onde: "pagina" };
      break;
    }
  }

  // ── criptografia / assinatura a nível de app ──
  const corpos = har.entradas.flatMap((e) => [e.reqBody, e.respBody]).filter(Boolean);
  const payloadCifrado = corpos.some(
    (c) => typeof c === "string" && /^[A-Za-z0-9+/=_-]{80,}$/.test(c.replace(/\s/g, "")),
  );
  const assinaturaHmac = har.entradas.some((e) =>
    Object.keys(e.reqHeaders ?? {}).some((k) => /signature|x-sign|hmac|x-signature/i.test(k)),
  );
  // pinning não é observável só pelo HAR; sinalizado externamente (captura).
  const certPinning = false;

  // ── PII trafegada ──
  const pii = new Set<string>();
  for (const e of har.entradas) {
    coletarPii(e.reqBody, pii);
    coletarPii(e.respBody, pii);
  }

  const interceptacaoLimitada = payloadCifrado || certPinning;

  return {
    auth: { obrigatorio: true, esquema, expiraToken: temBearer ? true : undefined },
    twoFactor: { presente: presente2fa, metodo: presente2fa ? "desconhecido" : undefined },
    captcha,
    transporte: { tlsTudo, httpPuroEm },
    criptografia: { payloadCifrado, assinaturaHmac, certPinning },
    piiTrafegada: [...pii],
    interceptacaoLimitada,
  };
}
