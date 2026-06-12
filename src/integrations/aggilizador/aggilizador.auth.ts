/**
 * Autenticação no Aggilizador — 100% HTTP/REST, SEM browser e SEM 2FA
 * (✅ confirmado no HAR de 11/06/2026: auth stateless por JWT, sem Set-Cookie).
 *
 * Dois passos, dois tokens:
 *   1) POST /usuario/login?device=desktop { email, senha } → token PRINCIPAL
 *      (autoriza api-prod.aggilizador.com.br). Valida statusCorretora e a
 *      permissão de AUTO antes de prosseguir.
 *   2) POST /usuario/login/pdocs (token PRINCIPAL CRU no Authorization, SEM
 *      "Bearer ") → token MULTICÁLCULO (autoriza api.multicalculo.net).
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
import { erroCurtoAggilizador } from "./aggilizador.erros-curto";
import { aggPost, authHeader } from "./aggilizador.http";
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
 * Descreve uma resposta de login que veio SEM `token` (sem expor token/senha):
 * status HTTP + chaves do objeto (ou tipo) + qualquer message/mensagem/erro.
 * Revela envelope diferente do esperado, anti-bot/WAF (corpo HTML → tipo=string),
 * ou erro de negócio que não veio como HTTP de erro.
 */
function diagSemToken(status: number, data: unknown): string {
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    const msg = [o.message, o.mensagem, o.erro, o.error].find((x) => typeof x === "string");
    const chaves = Object.keys(o).join(",") || "{}";
    return `HTTP ${status}; chaves=${chaves}${msg ? `; msg="${String(msg).slice(0, 140)}"` : ""}`;
  }
  return `HTTP ${status}; tipo=${typeof data}`;
}

/** Mescla o envelope aninhado `data` com o topo (topo vence) num único record,
 *  tolerando os 2 formatos observados (flat OU `{ message, data:{...} }`). */
function mesclarEnvelope(resp: { data?: Record<string, unknown> } | undefined): Record<string, unknown> {
  const root = (resp ?? {}) as Record<string, unknown>;
  const data = (root.data as Record<string, unknown> | undefined) ?? {};
  return { ...data, ...root };
}
function strOuUndef(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
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
  let loginStatus = 0;
  try {
    const r = await aggPost<AggilizadorLoginResponse>(
      `${AGGILIZADOR_PROD_BASE_URL}${AGGILIZADOR_PROD_API.login}`,
      { email: credenciais.email, senha: credenciais.senha },
    );
    login = r.data;
    loginStatus = r.status;
  } catch (e) {
    const status = axios.isAxiosError(e) ? e.response?.status : undefined;
    if (status === 401 || status === 403) {
      throw new AggilizadorAuthError(
        "Credenciais do Aggilizador inválidas (HTTP " + status + ") — corrija em Admin.",
      );
    }
    // rede/5xx/400/formato: inclui status + motivo sanitizado (sem senha) para
    // que `ultimo_teste_msg` aponte a causa real (timeout/refused vs HTTP NNN).
    throw new AggilizadorAuthError(`Aggilizador: falha no login — ${erroCurtoAggilizador(e)}`);
  }

  // Envelope tolerante: o token pode vir no topo OU dentro de `data`.
  const m = mesclarEnvelope(login);
  const token = strOuUndef(m.token);
  if (!token) {
    // Conflito de SESSÃO ÚNICA: o Aggilizador permite só 1 sessão por usuário e já
    // há uma aberta (ex.: humano logado no navegador com o mesmo login).
    const msg = strOuUndef(m.message) ?? "";
    if (/sess[aã]o ativa|active session|j[aá] existe uma sess/i.test(msg)) {
      throw new AggilizadorAuthError(
        "Não foi possível conectar ao Aggilizador: já existe OUTRA sessão aberta com este usuário " +
          "(o Aggilizador permite apenas 1 sessão por login). Feche a outra sessão — por exemplo, saia " +
          "do Aggilizador no navegador — e tente novamente. Para uso contínuo, cadastre um usuário " +
          "dedicado só para a integração.",
      );
    }
    const diag = diagSemToken(loginStatus, login);
    logger.warn("[aggilizador.auth] login sem token", { diag });
    throw new AggilizadorAuthError(`Login do Aggilizador não retornou token (${diag}).`);
  }
  const statusCorretora = typeof m.statusCorretora === "number" ? m.statusCorretora : 1;
  if (statusCorretora !== 1) {
    throw new AggilizadorConfigError(`Corretora inativa no Aggilizador (statusCorretora=${statusCorretora}).`);
  }
  if (!autoContratado(m.permissoesCorretora as AggilizadorLoginResponse["permissoesCorretora"])) {
    throw new AggilizadorConfigError("Módulo AUTO não contratado no Aggilizador para esta corretora.");
  }
  const corretoraId = strOuUndef(m.corretoraId) ?? "";
  const expires = typeof m.expires === "number" ? m.expires : Date.now() + 3 * 60 * 60 * 1000;

  // 2) Login secundário (pdocs) → token do motor Multicálculo.
  let pdocs: AggilizadorPdocsResponse;
  let pdocsStatus = 0;
  try {
    const r = await aggPost<AggilizadorPdocsResponse>(
      `${AGGILIZADOR_PROD_BASE_URL}${AGGILIZADOR_PROD_API.loginPdocs}`,
      {},
      authHeader(token), // JWT cru (sem "Bearer ") — ver authHeader/probe 12/06.
    );
    pdocs = r.data;
    pdocsStatus = r.status;
  } catch (e) {
    throw new AggilizadorAuthError(
      `Aggilizador: falha no login secundário (pdocs) — ${erroCurtoAggilizador(e)}`,
    );
  }
  const mp = mesclarEnvelope(pdocs);
  const tokenMulticalculo = strOuUndef(mp.token);
  if (!tokenMulticalculo) {
    throw new AggilizadorAuthError(`Login pdocs não retornou token (${diagSemToken(pdocsStatus, pdocs)}).`);
  }
  const expiresMulticalculo = typeof mp.expires === "number" ? mp.expires : Date.now() + 3 * 60 * 60 * 1000;

  const sessao: AggilizadorSessao = {
    tokenPrincipal: token,
    tokenMulticalculo,
    corretoraId,
    expires,
    expiresMulticalculo,
  };
  _cache.set(chave, sessao);
  logger.info("[aggilizador.auth] autenticado (HTTP, sem 2FA)", {
    corretoraId: sessao.corretoraId,
    expiraEm: new Date(sessao.expires).toISOString(),
  });
  return sessao;
}
