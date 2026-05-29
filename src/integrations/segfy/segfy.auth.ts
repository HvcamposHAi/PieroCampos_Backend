/**
 * Autenticação Segfy: obtém e renova o token de acesso.
 *
 * ⚠️ GATE: a forma do login/refresh NÃO está confirmada (ver endpoints.ts e
 * segfy.types.ts). Pode ser que a Segfy use cookie/CSRF em vez de bearer token;
 * nesse caso, a captura de token via scraper (segfy.scraper.ts) é o fallback.
 * Nunca logamos email/senha/token.
 *
 * ⚠️ 2FA (a partir de 01/06/2026): a Segfy passa a enviar código de 2 fatores
 * por e-mail no login. POST /auth/login com {email,password} provavelmente
 * deixará de bastar (espere um 2º passo / token de desafio). Antes de habilitar
 * em produção, avaliar usuário de API isento de 2FA ou API oficial negociada;
 * captura de token via scraper também esbarra no mesmo gate.
 */
import axios from "axios";
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import { AuthResponseSchema } from "./segfy.types";
import { SEGFY_ENDPOINTS } from "./endpoints";

let tokenAtual: string | null = null;
let tokenExpiraEm: Date | null = null;

/** Identidade do login (usuarioId/assinaturaId) — usada pela API de automação. */
export interface IdentidadeSegfy {
  usuarioId: number;
  assinaturaId: number;
}
let identidadeAtual: IdentidadeSegfy | null = null;

/** Identidade do último login REST, ou null (ex.: token veio só do scraper). */
export function getIdentidadeSegfy(): IdentidadeSegfy | null {
  return identidadeAtual;
}

/** Margem de segurança: renova faltando 5 min para expirar. */
const MARGEM_MS = 5 * 60 * 1000;
/** Validade assumida quando a API não informa expires_in. */
const VALIDADE_PADRAO_S = 50 * 60;

export function baseUrl(): string {
  const url = getEnv().SEGFY_API_URL;
  if (!url) {
    throw new Error(
      "SEGFY_API_URL não configurada — rode `npm run segfy:mapear` e defina a base URL real da API.",
    );
  }
  return url.replace(/\/+$/, "");
}

/** Invalida o token em cache (ex.: após um 401). */
export function invalidarToken(): void {
  tokenAtual = null;
  tokenExpiraEm = null;
}

export async function getToken(): Promise<string> {
  const agora = new Date();
  if (tokenAtual && tokenExpiraEm && tokenExpiraEm.getTime() - MARGEM_MS > agora.getTime()) {
    return tokenAtual;
  }

  logger.info("Segfy: renovando token de autenticação");
  const env = getEnv();

  const resp = await axios.post(
    `${baseUrl()}${SEGFY_ENDPOINTS.auth.login}`,
    { email: env.SEGFY_LOGIN, password: env.SEGFY_SENHA },
    { timeout: 30_000, headers: { "Content-Type": "application/json" } },
  );

  const auth = AuthResponseSchema.parse(resp.data);

  // O login não retorna expires_in — usamos a validade padrão.
  tokenAtual = auth.data.token;
  tokenExpiraEm = new Date(Date.now() + VALIDADE_PADRAO_S * 1000);
  identidadeAtual = { usuarioId: auth.data.usuarioId, assinaturaId: auth.data.assinaturaId };
  return tokenAtual;
}

/** Permite injetar um token capturado externamente (ex.: pelo scraper). */
export function definirTokenManual(token: string, validadeSegundos = VALIDADE_PADRAO_S): void {
  tokenAtual = token;
  tokenExpiraEm = new Date(Date.now() + validadeSegundos * 1000);
}
