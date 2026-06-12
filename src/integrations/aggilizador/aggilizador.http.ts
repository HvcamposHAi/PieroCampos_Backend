/**
 * Camada HTTP única e robusta do Aggilizador (benchmark: Segfy `segfyAPIComRetry`).
 *
 * TODAS as chamadas (auth + multicalculo) passam por `aggilizadorRequest`, que:
 *  1) usa o `aggilizadorHttpsAgent` (corrige a cadeia TLS GoDaddy incompleta);
 *  2) envia HEADERS FIÉIS AO NAVEGADOR (sec-ch-ua, sec-fetch-*, accept-language,
 *     UA desktop) — reduz o fingerprint que faz WAF/borda devolver 403 vazio;
 *  3) faz RETRY com backoff linear em falhas TRANSITÓRIAS (rede, 5xx, 429, TLS
 *     intermitente, timeout, 403 sem corpo) e NÃO repete erro de negócio (400/
 *     401/422) — espelha a política do Segfy;
 *  4) emite DIAGNÓSTICO rico no log (status + corpo sanitizado + headers-chave
 *     como server/cf-ray/x-amzn) para que um bloqueio de borda fique auto-evidente.
 *
 * Nunca loga senha/token; CPF é mascarado.
 */
import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios";
import { logger } from "../../utils/logger";
import { aggilizadorHttpsAgent } from "./aggilizador.tls";

/**
 * Headers fiéis a um Chrome desktop (origin/referer do app Aggilizador).
 * ✅ Conferidos byte-a-byte com o HAR de sessão real (12/06/2026): TODA request
 * do app leva accept/accept-language/cache-control/pragma/priority/content-type/
 * origin/referer/sec-ch-* + user-agent. `sec-fetch-site` NÃO entra aqui porque
 * varia por host de destino — é resolvido por `secFetchSite()` em cada chamada.
 */
export const AGGILIZADOR_HEADERS_BASE: Record<string, string> = {
  accept: "application/json, text/plain, */*",
  "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "cache-control": "no-cache",
  "content-type": "application/json",
  origin: "https://aggilizador.com.br",
  pragma: "no-cache",
  priority: "u=1, i",
  referer: "https://aggilizador.com.br/",
  "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
};

/**
 * Resolve o `sec-fetch-site` igual ao navegador (causa-raiz do pdocs 403):
 * a origem é `aggilizador.com.br`, logo chamadas a `*.aggilizador.com.br`
 * (api-prod) são **same-site**, e a `api.multicalculo.net` é **cross-site**.
 * Mandar `cross-site` fixo para o api-prod fazia a borda/WAF devolver 403 vazio.
 */
export function secFetchSite(url: string): "same-site" | "cross-site" {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "aggilizador.com.br" || host.endsWith(".aggilizador.com.br")
      ? "same-site"
      : "cross-site";
  } catch {
    return "cross-site";
  }
}

const MAX_TENTATIVAS = 3;
const BACKOFF_MS = 1_500;

function dormir(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Mascara CPF (11 dígitos) e corta. Nunca lança. */
function sanitizar(s: string, max = 800): string {
  return s.replace(/\b\d{11}\b/g, "***").slice(0, max);
}

/**
 * Decide se vale repetir. Repete TRANSITÓRIOS (rede/5xx/429/TLS-intermitente/
 * timeout/403-sem-corpo); NÃO repete erro de negócio (400/401/422) nem 403 com
 * corpo (rejeição explícita do app).
 */
function ehTransitorio(e: unknown): boolean {
  if (axios.isAxiosError(e)) {
    const code = e.code ?? "";
    if (["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ECONNREFUSED"].includes(code)) return true;
    if (/UNABLE_TO_VERIFY|CERT_|SELF_SIGNED/i.test(code)) return true; // TLS intermitente
    const status = e.response?.status;
    if (status === undefined) return true; // sem resposta = rede
    if (status === 429 || status >= 500) return true;
    // 403 SEM corpo → provável borda/WAF intermitente: vale 1 nova tentativa.
    if (status === 403 && !e.response?.data) return true;
    return false; // 400/401/422/403-com-corpo etc.: erro definitivo
  }
  const msg = e instanceof Error ? e.message : String(e);
  return /UNABLE_TO_VERIFY|ETIMEDOUT|ECONNRESET|socket hang up|network/i.test(msg);
}

/** Diagnóstico rico no log (sem PII): status + headers-chave + corpo sanitizado. */
function diagnosticar(e: unknown, url: string): void {
  if (!axios.isAxiosError(e)) {
    logger.warn("[aggilizador.http] erro não-HTTP", { url, erro: (e as Error)?.message });
    return;
  }
  const r = e.response;
  const h = (r?.headers ?? {}) as Record<string, unknown>;
  const body = r?.data == null ? "" : typeof r.data === "string" ? r.data : JSON.stringify(r.data);
  logger.warn("[aggilizador.http] resposta de erro", {
    url,
    status: r?.status,
    code: e.code,
    server: h["server"],
    cfRay: h["cf-ray"],
    via: h["via"],
    amzn: h["x-amzn-requestid"] ?? h["x-amzn-errortype"],
    contentType: h["content-type"],
    bodyVazio: !body,
    body: sanitizar(body),
  });
}

/**
 * Request central do Aggilizador. Mescla headers base + os do caller (caller
 * vence, ex.: Authorization), injeta o https.Agent e aplica retry/backoff +
 * diagnóstico. Rejeita com o ERRO ORIGINAL do axios (o caller usa
 * `erroCurtoAggilizador` para a mensagem da tela).
 */
export async function aggilizadorRequest<T = unknown>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
  const url = String(config.url ?? "");
  const cfg: AxiosRequestConfig = {
    timeout: 30_000,
    ...config,
    httpsAgent: aggilizadorHttpsAgent,
    // `sec-fetch-site` resolvido por host (same-site p/ api-prod, cross-site p/
    // multicalculo); o caller ainda pode sobrescrever qualquer header.
    headers: { ...AGGILIZADOR_HEADERS_BASE, "sec-fetch-site": secFetchSite(url), ...(config.headers ?? {}) },
  };
  let ultimo: unknown;
  for (let tentativa = 0; tentativa < MAX_TENTATIVAS; tentativa++) {
    try {
      return await axios.request<T>(cfg);
    } catch (e) {
      ultimo = e;
      diagnosticar(e, url);
      if (tentativa < MAX_TENTATIVAS - 1 && ehTransitorio(e)) {
        await dormir(BACKOFF_MS * (tentativa + 1)); // backoff linear (1.5s, 3s)
        continue;
      }
      throw e;
    }
  }
  throw ultimo;
}

/** Açúcar p/ GET e POST mantendo a assinatura simples dos call-sites. */
export async function aggGet<T = unknown>(url: string, headers?: Record<string, string>, timeout?: number): Promise<T> {
  return (await aggilizadorRequest<T>({ method: "GET", url, headers, timeout })).data;
}
export async function aggPost<T = unknown>(
  url: string,
  data: unknown,
  headers?: Record<string, string>,
  timeout?: number,
): Promise<AxiosResponse<T>> {
  return aggilizadorRequest<T>({ method: "POST", url, data, headers, timeout });
}
