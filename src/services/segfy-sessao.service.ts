/**
 * Sessão confiável do Segfy (contorno do 2FA) — camada de serviço.
 *
 * O Segfy passou a exigir 2FA por e-mail no login (01/06/2026). O login 100% HTTP
 * do bot cai no desafio e não recebe os tokens de automação. A saída é uma
 * REAUTENTICAÇÃO ASSISTIDA: o operador (Admin › Segfy) loga UMA vez via navegador,
 * digita o código 2FA, marcamos "lembrar 30 dias" e guardamos a sessão confiável
 * (cookies de device trust) + os tokens — tudo CIFRADO em `segfy_credenciais`.
 * As cotações seguintes reinjetam esses cookies no login HTTP e passam sem 2FA.
 *
 * Isolamento: o módulo `integrations/segfy/*` não conhece Supabase. A persistência
 * (cifra + banco) e o estado in-flight do navegador vivem AQUI.
 */
import { randomUUID } from "node:crypto";
import { cifrar, decifrar, type PayloadCifrado } from "../integrations/whatsapp/cipher";
import { getSupabaseAdmin } from "../integrations/whatsapp/supabase";
import { logger } from "../utils/logger";
import { getEnv } from "../config/env";
import { obterCredenciaisSegfy } from "./segfy-credenciais.service";
import {
  abortarReauthSegfy,
  confirmarReauthSegfy,
  iniciarReauthSegfy,
  type ReauthHandle,
  type ResultadoReauth,
  type TokensCapturados,
} from "../integrations/segfy/segfy.scraper";
import type { SegfySessaoInjetada, SegfyTokens } from "../integrations/segfy/segfy.multicalculo";

const ID_SINGLETON = "singleton";
/** Validade estimada do device trust ("lembrar 30 dias"). */
const SESSAO_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Validade assumida dos tokens de automação capturados (idToken ~1h; margem). */
const TOKENS_TTL_MS = 50 * 60 * 1000;
/** Janela para o operador digitar o código antes de o navegador ser descartado. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type StatusSessao = "ativa" | "expirada" | "ausente";

export interface SessaoInfo {
  status: StatusSessao;
  atualizada_em: string | null;
  valida_ate: string | null;
  reauth_por: string | null;
}

interface LinhaSessao {
  sessao_cifrada: PayloadCifrado | null;
  tokens_cifrados: PayloadCifrado | null;
  sessao_status: StatusSessao | null;
  sessao_atualizada_em: string | null;
  sessao_valida_ate: string | null;
  reauth_por: string | null;
  sessao_ultimo_aviso_em: string | null;
}

/**
 * Blob de sessão persistido (cifrado). Dois formatos:
 *  - importação de cookie (Render, sem navegador): `{ cookieHeader }`.
 *  - captura por navegador (host com Chromium): `storageState` com `cookies[]`.
 */
interface SessaoBlob {
  cookieHeader?: string;
  cookies?: Array<{ name: string; value: string; domain?: string }>;
}

// ── Estado in-flight (entre "iniciar" e "confirmar") ─────────────────────────
interface Challenge {
  handle: ReauthHandle;
  expiraEm: number;
  porEmail: string | null;
}
const desafios = new Map<string, Challenge>();

/** Descarta navegadores de desafios que estouraram a janela (libera memória). */
function limparExpirados(): void {
  const agora = Date.now();
  for (const [id, c] of desafios) {
    if (c.expiraEm <= agora) {
      desafios.delete(id);
      void abortarReauthSegfy(c.handle).catch(() => undefined);
    }
  }
}

// ── Persistência ─────────────────────────────────────────────────────────────

/**
 * Importa a sessão confiável a partir do navegador JÁ logado do operador (sem
 * rodar navegador no servidor): grava o cabeçalho `Cookie` (device trust) cifrado
 * e, opcionalmente, os tokens de automação para uma janela imediata de cotação.
 */
export async function importarSessao(input: {
  cookieHeader: string;
  tokens?: TokensCapturados;
  porEmail?: string | null;
}): Promise<void> {
  const sb = getSupabaseAdmin();
  const agora = new Date();
  const patch: Record<string, unknown> = {
    sessao_cifrada: cifrar({ cookieHeader: input.cookieHeader.trim() }),
    sessao_status: "ativa",
    sessao_atualizada_em: agora.toISOString(),
    sessao_valida_ate: new Date(agora.getTime() + SESSAO_TTL_MS).toISOString(),
    reauth_por: input.porEmail ?? null,
  };
  if (input.tokens?.authAutomationToken && input.tokens?.userAutomationToken) {
    patch.tokens_cifrados = cifrar(input.tokens);
  }
  // UPDATE (não upsert): a linha singleton já existe (credenciais salvas). Assim
  // não tocamos a coluna `email` (NOT NULL) que o upsert exigiria.
  const { data, error } = await sb
    .from("segfy_credenciais")
    .update(patch)
    .eq("id", ID_SINGLETON)
    .select("id");
  if (error) throw new Error(`importarSessao: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error("importarSessao: credenciais do Segfy não configuradas (cadastre o login antes).");
  }
  logger.info("[segfy.sessao] sessão importada (cookie)", { por: input.porEmail ?? null });
}

async function persistirSessao(resultado: ResultadoReauth, porEmail: string | null): Promise<void> {
  const sb = getSupabaseAdmin();
  const agora = new Date();
  const patch: Record<string, unknown> = {
    sessao_cifrada: cifrar(resultado.storageState),
    sessao_status: "ativa",
    sessao_atualizada_em: agora.toISOString(),
    sessao_valida_ate: new Date(agora.getTime() + SESSAO_TTL_MS).toISOString(),
    reauth_por: porEmail,
  };
  if (resultado.tokens) patch.tokens_cifrados = cifrar(resultado.tokens);
  // UPDATE (não upsert): a linha singleton já existe; não tocamos `email` (NOT NULL).
  const { data, error } = await sb
    .from("segfy_credenciais")
    .update(patch)
    .eq("id", ID_SINGLETON)
    .select("id");
  if (error) throw new Error(`persistirSessao: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error("persistirSessao: credenciais do Segfy não configuradas (linha singleton ausente).");
  }
  logger.info("[segfy.sessao] sessão confiável persistida", { por: porEmail });
}

async function lerLinha(): Promise<LinhaSessao | null> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("segfy_credenciais")
    .select(
      "sessao_cifrada, tokens_cifrados, sessao_status, sessao_atualizada_em, sessao_valida_ate, reauth_por, sessao_ultimo_aviso_em",
    )
    .eq("id", ID_SINGLETON)
    .maybeSingle();
  if (error || !data) return null;
  return data as LinhaSessao;
}

// ── API pública ──────────────────────────────────────────────────────────────

/**
 * Passo 1 da reauth assistida. Sobe o navegador e loga; se cair no 2FA, devolve
 * um `challengeId` e aguarda o código. Se o dispositivo já for confiável, conclui
 * na hora (estado 'concluido').
 */
export async function iniciarReauth(opts: { porEmail?: string | null } = {}): Promise<
  | { estado: "aguardando_codigo"; challengeId: string; email: string }
  | { estado: "concluido" }
> {
  // Defesa em profundidade: erro ANTES de qualquer trabalho quando o scraping
  // está off (o gate primário vive em segfy.scraper). O contorno é "Importar
  // sessão" (cookie), que NÃO passa por aqui e segue funcionando.
  if (!getEnv().SEGFY_SCRAPING_ENABLED) throw new Error("scraping_desabilitado");
  limparExpirados();
  const creds = await obterCredenciaisSegfy();
  if (!creds) throw new Error("sem_credenciais");

  // Tenta reaproveitar a sessão anterior para pular o 2FA quando possível.
  let storageState: unknown;
  try {
    const linha = await lerLinha();
    if (linha?.sessao_cifrada) storageState = decifrar(linha.sessao_cifrada);
  } catch {
    /* sessão anterior ilegível — segue sem ela */
  }

  const env = getEnv();
  const { handle, estado, resultado } = await iniciarReauthSegfy({
    email: creds.email,
    password: creds.password,
    headless: env.SEGFY_HEADLESS,
    storageState,
  });

  if (estado === "concluido" && resultado) {
    await persistirSessao(resultado, opts.porEmail ?? null);
    return { estado: "concluido" };
  }

  const challengeId = randomUUID();
  desafios.set(challengeId, {
    handle,
    expiraEm: Date.now() + CHALLENGE_TTL_MS,
    porEmail: opts.porEmail ?? null,
  });
  return { estado: "aguardando_codigo", challengeId, email: creds.email };
}

/** Passo 2 da reauth assistida: aplica o código 2FA e persiste a sessão. */
export async function confirmarReauth(input: { challengeId: string; codigo: string }): Promise<void> {
  // Guard simétrico: se a flag foi desligada entre iniciar e confirmar, falha limpo.
  if (!getEnv().SEGFY_SCRAPING_ENABLED) throw new Error("scraping_desabilitado");
  limparExpirados();
  const desafio = desafios.get(input.challengeId);
  if (!desafio) throw new Error("challenge_invalido");
  desafios.delete(input.challengeId);

  const resultado = await confirmarReauthSegfy(desafio.handle, input.codigo.trim());
  await persistirSessao(resultado, desafio.porEmail);
}

/** Status da sessão para a tela (NUNCA expõe cookies/tokens). */
export async function statusSessao(): Promise<SessaoInfo> {
  const ausente: SessaoInfo = { status: "ausente", atualizada_em: null, valida_ate: null, reauth_por: null };
  try {
    const linha = await lerLinha();
    if (!linha || !linha.sessao_cifrada) return ausente;
    // Expirou pela data estimada → reflete 'expirada' mesmo que o banco diga 'ativa'.
    const expirouPorData =
      !!linha.sessao_valida_ate && new Date(linha.sessao_valida_ate).getTime() <= Date.now();
    const status: StatusSessao = expirouPorData ? "expirada" : linha.sessao_status ?? "ativa";
    return {
      status,
      atualizada_em: linha.sessao_atualizada_em,
      valida_ate: linha.sessao_valida_ate,
      reauth_por: linha.reauth_por,
    };
  } catch (e) {
    logger.warn("[segfy.sessao] status falhou", { erro: (e as Error).message });
    return ausente;
  }
}

/**
 * Marca a sessão como expirada (reauth necessária). Best-effort.
 * Retorna `true` se houve TRANSIÇÃO (não estava expirada antes) — usado p/ avisar
 * o operador UMA vez por expiração (sem spam a cada cotação).
 */
export async function marcarSessaoExpirada(): Promise<boolean> {
  try {
    const sb = getSupabaseAdmin();
    const linha = await lerLinha();
    const jaExpirada = linha?.sessao_status === "expirada";
    await sb.from("segfy_credenciais").update({ sessao_status: "expirada" }).eq("id", ID_SINGLETON);
    if (!jaExpirada) logger.warn("[segfy.sessao] sessão marcada como expirada — reauth necessária");
    return !jaExpirada;
  } catch (e) {
    logger.warn("[segfy.sessao] não consegui marcar sessão expirada", { erro: (e as Error).message });
    return false;
  }
}

/** Invalida a sessão (ex.: troca de senha no Admin). */
export async function invalidarSessao(): Promise<void> {
  await marcarSessaoExpirada();
}

/**
 * Checagem PROATIVA (chamada pelo cron token-gated): se a sessão está 'ativa' e
 * expira em ≤ N dias (SEGFY_AVISO_ANTECEDENCIA_DIAS), devolve o motivo do aviso e
 * grava o throttle (`sessao_ultimo_aviso_em`, ≥20h). Não notifica aqui — quem
 * notifica é a rota (separação: este módulo não conhece o serviço de alertas).
 */
export async function avisoProativoSessao(): Promise<{ avisar: boolean; motivo?: string }> {
  try {
    const linha = await lerLinha();
    if (!linha || linha.sessao_status !== "ativa" || !linha.sessao_valida_ate) return { avisar: false };
    const diasRestantes = (new Date(linha.sessao_valida_ate).getTime() - Date.now()) / 86_400_000;
    if (diasRestantes > getEnv().SEGFY_AVISO_ANTECEDENCIA_DIAS) return { avisar: false };
    // Throttle: no máximo 1 aviso a cada 20h.
    if (linha.sessao_ultimo_aviso_em && Date.now() - new Date(linha.sessao_ultimo_aviso_em).getTime() < 20 * 3_600_000) {
      return { avisar: false };
    }
    const sb = getSupabaseAdmin();
    await sb
      .from("segfy_credenciais")
      .update({ sessao_ultimo_aviso_em: new Date().toISOString() })
      .eq("id", ID_SINGLETON);
    const dias = Math.max(0, Math.ceil(diasRestantes));
    return {
      avisar: true,
      motivo: `A sessão do Segfy expira em ~${dias} dia(s). Reautentique para não interromper as cotações.`,
    };
  } catch (e) {
    logger.warn("[segfy.sessao] avisoProativo falhou", { erro: (e as Error).message });
    return { avisar: false };
  }
}

/** Converte os tokens capturados (no formato da resposta) para o formato do multicálculo. */
function paraSegfyTokens(t: TokensCapturados): SegfyTokens {
  return { bearer: `Bearer ${t.authAutomationToken}`, automationToken: t.userAutomationToken };
}

/** Monta o header Cookie do blob: usa o `cookieHeader` importado ou os cookies do storageState. */
function montarCookieHeader(blob: SessaoBlob): string | undefined {
  if (blob.cookieHeader && blob.cookieHeader.trim()) return blob.cookieHeader.trim();
  const cookies = (blob.cookies ?? []).filter((c) => (c.domain ?? "").includes("segfy"));
  if (cookies.length === 0) return undefined;
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Restaura a sessão confiável para o caminho de cotação: devolve o cookie de
 * device trust (p/ o login HTTP pular o 2FA) e os tokens persistidos (atalho
 * enquanto válidos). `null` se não há sessão utilizável.
 */
export async function restaurarSessao(): Promise<SegfySessaoInjetada | null> {
  try {
    const linha = await lerLinha();
    if (!linha || !linha.sessao_cifrada) return null;
    if (linha.sessao_status === "expirada") return null;
    if (linha.sessao_valida_ate && new Date(linha.sessao_valida_ate).getTime() <= Date.now()) return null;

    const blob = decifrar<SessaoBlob>(linha.sessao_cifrada);
    const cookie = montarCookieHeader(blob);

    let tokens: SegfyTokens | undefined;
    let tokensValidadeMs: number | undefined;
    if (linha.tokens_cifrados && linha.sessao_atualizada_em) {
      const cap = decifrar<TokensCapturados>(linha.tokens_cifrados);
      if (cap?.authAutomationToken && cap?.userAutomationToken) {
        tokens = paraSegfyTokens(cap);
        const idade = Date.now() - new Date(linha.sessao_atualizada_em).getTime();
        tokensValidadeMs = Math.max(0, TOKENS_TTL_MS - idade);
      }
    }
    if (!cookie && !tokens) return null;
    return { cookie, tokens, tokensValidadeMs };
  } catch (e) {
    logger.warn("[segfy.sessao] restaurar falhou", { erro: (e as Error).message });
    return null;
  }
}
