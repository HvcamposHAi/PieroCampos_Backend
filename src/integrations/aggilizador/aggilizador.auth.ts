/**
 * Autenticação no Aggilizador — 100% HTTP/REST, SEM browser e SEM 2FA
 * (✅ confirmado no HAR de 11/06/2026: auth stateless por JWT, sem Set-Cookie).
 *
 * Dois passos, dois tokens:
 *   1) POST /usuario/login?device=desktop { email, senha } → token PRINCIPAL
 *      (autoriza api-prod.aggilizador.com.br). Valida statusCorretora e a
 *      permissão de AUTO antes de prosseguir.
 *   2) POST /usuario/login/pdocs (Bearer do principal) → token MULTICÁLCULO
 *      (autoriza api.multicalculo.net).
 *
 * O JWT dura ~3h; `expires` vem em EPOCH MS (não segundos). Cache em memória por
 * e-mail (multi-tenant: cada corretora tem o seu login), renovado com margem.
 *
 * O módulo recebe as credenciais como DADO (parâmetro) — não conhece Supabase. A
 * camada de serviço resolve o login da corretora via `obterCredenciaisSegfy`.
 */
import axios from "axios";
import { logger } from "../../utils/logger";
import { AGGILIZADOR_PROD_API, AGGILIZADOR_PROD_BASE_URL } from "./endpoints";
import { AggilizadorAuthError, AggilizadorConfigError } from "./errors";
import type {
  AggilizadorLoginResponse,
  AggilizadorPdocsResponse,
  AggilizadorSessao,
} from "./aggilizador.types";

/** Credenciais do login do Aggilizador da corretora (mesma linha do Segfy no banco). */
export interface CredenciaisAggilizador {
  email: string;
  senha: string;
}

/** Headers de navegador que a API espera (origin/referer checados). */
export const AGGILIZADOR_HEADERS: Record<string, string> = {
  accept: "application/json, text/plain, */*",
  "content-type": "application/json",
  origin: "https://aggilizador.com.br",
  referer: "https://aggilizador.com.br/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

/** Margem para renovar antes de expirar (5 min). */
const MARGEM_MS = 5 * 60 * 1000;

/** true se o token ainda é válido com a margem de segurança. */
export function isTokenValido(expiresMs: number): boolean {
  return Date.now() < expiresMs - MARGEM_MS;
}

const _cache = new Map<string, AggilizadorSessao>();

/** Reseta o cache de sessões (uso em testes / troca de credenciais). */
export function _resetAuthCache(email?: string): void {
  if (email) _cache.delete(email.toLowerCase());
  else _cache.clear();
}

/** Extrai a flag `permissoesCorretora.AUTO.contratado` de forma tolerante. */
function autoContratado(perm: AggilizadorLoginResponse["permissoesCorretora"]): boolean {
  const auto = (perm as Record<string, { contratado?: boolean }> | undefined)?.AUTO;
  // Se a API não retornar o bloco de permissões, NÃO bloqueamos (fail-open no gate
  // de permissão — o erro real apareceria no calcularV2). Só bloqueia se vier
  // explicitamente contratado:false.
  return auto?.contratado !== false;
}

/**
 * Autentica e devolve os dois tokens. Cacheia por e-mail; `forcar` ignora o cache.
 * Lança `AggilizadorAuthError` (credencial) ou `AggilizadorConfigError` (conta).
 */
export async function loginAggilizador(
  credenciais: CredenciaisAggilizador,
  forcar = false,
): Promise<AggilizadorSessao> {
  const chave = credenciais.email.toLowerCase();
  const cached = _cache.get(chave);
  if (!forcar && cached && isTokenValido(cached.expires) && isTokenValido(cached.expiresMulticalculo)) {
    return cached;
  }

  // 1) Login principal.
  let login: AggilizadorLoginResponse;
  try {
    const r = await axios.post<AggilizadorLoginResponse>(
      `${AGGILIZADOR_PROD_BASE_URL}${AGGILIZADOR_PROD_API.login}`,
      { email: credenciais.email, senha: credenciais.senha },
      { headers: AGGILIZADOR_HEADERS, timeout: 30_000 },
    );
    login = r.data;
  } catch (e) {
    const status = axios.isAxiosError(e) ? e.response?.status : undefined;
    if (status === 401 || status === 403) {
      throw new AggilizadorAuthError(
        "Credenciais do Aggilizador inválidas (HTTP " + status + ") — corrija em Admin.",
      );
    }
    throw new AggilizadorAuthError(); // rede/5xx/formato → erro de auth genérico
  }
  if (!login?.token) throw new AggilizadorAuthError("Login do Aggilizador não retornou token.");
  if (login.statusCorretora !== 1) {
    throw new AggilizadorConfigError(
      `Corretora inativa no Aggilizador (statusCorretora=${login.statusCorretora}).`,
    );
  }
  if (!autoContratado(login.permissoesCorretora)) {
    throw new AggilizadorConfigError("Módulo AUTO não contratado no Aggilizador para esta corretora.");
  }

  // 2) Login secundário (pdocs) → token do motor Multicálculo.
  let pdocs: AggilizadorPdocsResponse;
  try {
    const r = await axios.post<AggilizadorPdocsResponse>(
      `${AGGILIZADOR_PROD_BASE_URL}${AGGILIZADOR_PROD_API.loginPdocs}`,
      {},
      { headers: { ...AGGILIZADOR_HEADERS, Authorization: `Bearer ${login.token}` }, timeout: 30_000 },
    );
    pdocs = r.data;
  } catch {
    throw new AggilizadorAuthError("Falha no login secundário (pdocs) do Aggilizador.");
  }
  if (!pdocs?.token) throw new AggilizadorAuthError("Login pdocs não retornou token do Multicálculo.");

  const sessao: AggilizadorSessao = {
    tokenPrincipal: login.token,
    tokenMulticalculo: pdocs.token,
    corretoraId: login.corretoraId,
    expires: login.expires,
    expiresMulticalculo: pdocs.expires,
  };
  _cache.set(chave, sessao);
  logger.info("[aggilizador.auth] autenticado (HTTP, sem 2FA)", {
    corretoraId: sessao.corretoraId,
    expiraEm: new Date(sessao.expires).toISOString(),
  });
  return sessao;
}
