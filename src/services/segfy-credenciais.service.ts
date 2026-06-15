/**
 * Credenciais do portal Segfy (conta única) — fonte preferencial para o login,
 * com fallback para o .env. A SENHA fica CIFRADA (AES-256-GCM via cipher.ts,
 * chave WA_AUTH_ENCRYPTION_KEY) na tabela `segfy_credenciais`, acessível só pelo
 * backend (service_role). Nunca devolvemos a senha ao front nem logamos seu valor.
 *
 * A leitura do banco vive AQUI (camada de serviço) — o módulo isolado
 * `src/integrations/segfy/*` continua sem conhecer Supabase: recebe as
 * credenciais como dado (parâmetro de obterTokensSegfy/cotarAuto).
 */
import { getEnv } from "../config/env";
import { cifrar, decifrar, type PayloadCifrado } from "../integrations/whatsapp/cipher";
import { getSupabaseAdmin } from "../integrations/whatsapp/supabase";
import { CORRETORA_SEED_ID } from "../integrations/persistence/supabase-persistence";
import { logger } from "../utils/logger";

export interface CredenciaisSegfy {
  email: string;
  password: string;
}

export type FonteCredenciais = "db" | "env" | "nenhuma";

export interface StatusCredenciais {
  configurado: boolean;
  fonte: FonteCredenciais;
  email: string | null;
  /** Sistema de cotação da corretora (default 'segfy'). */
  sistema: string | null;
  /** URL do sistema (informativa p/ Segfy; entrada da auto-descoberta p/ outros). */
  url: string | null;
  /** Comissão padrão (%) "coringa" da corretora (default das cotações). */
  comissao_padrao: number | null;
  atualizado_em: string | null;
  atualizado_por: string | null;
  ultimo_teste_em: string | null;
  ultimo_teste_ok: boolean | null;
  ultimo_teste_msg: string | null;
}

interface LinhaCredenciais {
  email: string | null;
  senha_cifrada: PayloadCifrado | null;
  atualizado_em: string | null;
  atualizado_por: string | null;
  ultimo_teste_em: string | null;
  ultimo_teste_ok: boolean | null;
  ultimo_teste_msg: string | null;
}

/**
 * Resolve as credenciais a usar no login: 1º a linha cifrada do banco; se não
 * houver (ou a decifra falhar), cai no `.env`; `null` se nenhum dos dois existir.
 */
export async function obterCredenciaisSegfy(
  corretoraId: string = CORRETORA_SEED_ID,
): Promise<(CredenciaisSegfy & { fonte: Exclude<FonteCredenciais, "nenhuma"> }) | null> {
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("segfy_credenciais")
      .select("email, senha_cifrada")
      .eq("corretora_id" as never, corretoraId as never)
      .maybeSingle();
    if (!error && data) {
      const linha = data as Pick<LinhaCredenciais, "email" | "senha_cifrada">;
      if (linha.email && linha.senha_cifrada) {
        try {
          const password = decifrar<string>(linha.senha_cifrada);
          return { email: linha.email, password, fonte: "db" };
        } catch (e) {
          logger.error("[segfy.cred] falha ao decifrar senha; usando fallback .env", {
            erro: (e as Error).message,
          });
        }
      }
    }
  } catch (e) {
    logger.warn("[segfy.cred] leitura do banco falhou; tentando .env", {
      erro: (e as Error).message,
    });
  }

  // Fallback .env só vale para a corretora SEED (Piero) — as demais usam o banco.
  if (corretoraId === CORRETORA_SEED_ID) {
    const env = getEnv();
    if (env.SEGFY_LOGIN && env.SEGFY_SENHA) {
      return { email: env.SEGFY_LOGIN, password: env.SEGFY_SENHA, fonte: "env" };
    }
  }
  return null;
}

/** Cifra a senha e grava (upsert) a credencial única. */
export async function salvarCredenciaisSegfy(input: {
  email: string;
  senha: string;
  corretoraId?: string;
  /** Sistema de cotação (default 'segfy' quando ausente). */
  sistema?: string | null;
  /** URL do sistema (informativa p/ Segfy; entrada p/ auto-descoberta). */
  url?: string | null;
  /** Comissão padrão (%) da corretora (0–100). */
  comissaoPadrao?: number | null;
  porEmail?: string | null;
}): Promise<void> {
  const corretoraId = input.corretoraId ?? CORRETORA_SEED_ID;
  const sb = getSupabaseAdmin();
  const senha_cifrada = cifrar(input.senha); // {iv,tag,ciphertext}
  // Por-corretora: 1 linha por corretora (UNIQUE(corretora_id) — cláusula 13).
  // id (PK text) = corretoraId; onConflict no corretora_id atualiza a existente.
  const payload: Record<string, unknown> = {
    id: corretoraId,
    corretora_id: corretoraId,
    email: input.email,
    senha_cifrada,
    atualizado_por: input.porEmail ?? null,
    atualizado_em: new Date().toISOString(),
  };
  if (input.sistema !== undefined) payload.sistema = input.sistema ?? "segfy";
  if (input.url !== undefined) payload.url = input.url;
  if (input.comissaoPadrao !== undefined) payload.comissao_padrao = input.comissaoPadrao;
  const { error } = await sb.from("segfy_credenciais").upsert(payload as never, {
    onConflict: "corretora_id",
  });
  if (error) throw new Error(`salvarCredenciaisSegfy: ${error.message}`);
  _invalidarSistemaCache(corretoraId); // troca de sistema reflete na próxima cotação
  logger.info("[segfy.cred] credenciais salvas", { email: input.email, por: input.porEmail });
}

/** Status para a tela (NUNCA inclui a senha). */
export async function statusCredenciaisSegfy(
  corretoraId: string = CORRETORA_SEED_ID,
): Promise<StatusCredenciais> {
  try {
    const sb = getSupabaseAdmin();
    const { data } = await sb
      .from("segfy_credenciais")
      .select(
        "email, sistema, url, comissao_padrao, atualizado_em, atualizado_por, ultimo_teste_em, ultimo_teste_ok, ultimo_teste_msg" as never,
      )
      .eq("corretora_id" as never, corretoraId as never)
      .maybeSingle();
    const linha = data as
      | (Omit<LinhaCredenciais, "senha_cifrada"> & {
          sistema?: string | null;
          url?: string | null;
          comissao_padrao?: number | null;
        })
      | null;
    if (linha?.email) {
      return {
        configurado: true,
        fonte: "db",
        email: linha.email,
        sistema: linha.sistema ?? "segfy",
        url: linha.url ?? null,
        comissao_padrao: linha.comissao_padrao ?? null,
        atualizado_em: linha.atualizado_em,
        atualizado_por: linha.atualizado_por,
        ultimo_teste_em: linha.ultimo_teste_em,
        ultimo_teste_ok: linha.ultimo_teste_ok,
        ultimo_teste_msg: linha.ultimo_teste_msg,
      };
    }
  } catch (e) {
    logger.warn("[segfy.cred] status: leitura do banco falhou", { erro: (e as Error).message });
  }

  const env = getEnv();
  if (corretoraId === CORRETORA_SEED_ID && env.SEGFY_LOGIN) {
    return {
      configurado: true,
      fonte: "env",
      email: env.SEGFY_LOGIN,
      sistema: "segfy",
      url: env.SEGFY_APP_URL ?? null,
      comissao_padrao: null,
      atualizado_em: null,
      atualizado_por: null,
      ultimo_teste_em: null,
      ultimo_teste_ok: null,
      ultimo_teste_msg: null,
    };
  }
  return {
    configurado: false,
    fonte: "nenhuma",
    email: null,
    sistema: "segfy",
    url: null,
    comissao_padrao: null,
    atualizado_em: null,
    atualizado_por: null,
    ultimo_teste_em: null,
    ultimo_teste_ok: null,
    ultimo_teste_msg: null,
  };
}

// ----------------------------------------------------------------------------
// Sistema de cotação efetivo da corretora (default 'segfy')
// ----------------------------------------------------------------------------
// Usado pelo registry (resolveProvider) para escolher o provider AUTOMATIZADO do
// ramo auto por corretora. FAIL-OPEN → 'segfy': qualquer falha de leitura mantém
// o comportamento atual (Segfy), nunca derruba a cotação. Cache TTL curto espelha
// lerMapperDinamicoAtivo (evita 1 round-trip por cotação sem segurar mudanças).
const SISTEMA_TTL_MS = 30_000;
const _sistemaCache = new Map<string, { valor: string; em: number }>();

/** Invalida o cache do sistema (chamado ao salvar credenciais). */
export function _invalidarSistemaCache(corretoraId?: string): void {
  if (corretoraId) _sistemaCache.delete(corretoraId);
  else _sistemaCache.clear();
}

/** Sistema de cotação da corretora ('segfy' | 'aggilizador' | ...). FAIL-OPEN 'segfy'. */
export async function lerSistemaCotacao(
  corretoraId: string = CORRETORA_SEED_ID,
): Promise<string> {
  const agora = Date.now();
  const cached = _sistemaCache.get(corretoraId);
  if (cached && agora - cached.em < SISTEMA_TTL_MS) return cached.valor;
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("segfy_credenciais")
      .select("sistema" as never)
      .eq("corretora_id" as never, corretoraId as never)
      .maybeSingle();
    if (error) {
      logger.warn("[segfy.cred] leitura do sistema falhou; fail-open (segfy)", {
        erro: error.message,
      });
      return "segfy"; // não cacheia erro
    }
    const sistema = (data as { sistema?: string | null } | null)?.sistema ?? "segfy";
    _sistemaCache.set(corretoraId, { valor: sistema, em: agora });
    return sistema;
  } catch (e) {
    logger.warn("[segfy.cred] exceção lendo sistema; fail-open (segfy)", {
      erro: (e as Error).message,
    });
    return "segfy";
  }
}

/**
 * Comissão padrão (%) "coringa" da corretora (default das cotações). FAIL-SAFE →
 * `null`: se a coluna ainda não existe (DDL não aplicada) ou a leitura falha,
 * devolve null e a cotação cai na comissão da seguradora. Não cacheia (chamado 1×
 * por cotação, custo desprezível).
 */
export async function lerComissaoPadrao(
  corretoraId: string = CORRETORA_SEED_ID,
): Promise<number | null> {
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("segfy_credenciais")
      .select("comissao_padrao" as never)
      .eq("corretora_id" as never, corretoraId as never)
      .maybeSingle();
    if (error) return null; // coluna ausente / erro → fallback seguro
    const v = (data as { comissao_padrao?: number | null } | null)?.comissao_padrao;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** Registra o resultado do "Testar conexão" (no-op se as creds vêm só do .env). */
export async function registrarTesteSegfy(
  ok: boolean,
  msg?: string,
  corretoraId: string = CORRETORA_SEED_ID,
): Promise<void> {
  try {
    const sb = getSupabaseAdmin();
    await sb
      .from("segfy_credenciais")
      .update({
        ultimo_teste_em: new Date().toISOString(),
        ultimo_teste_ok: ok,
        ultimo_teste_msg: msg ? msg.slice(0, 200) : null,
      })
      .eq("corretora_id" as never, corretoraId as never);
  } catch (e) {
    logger.warn("[segfy.cred] não consegui registrar resultado do teste", {
      erro: (e as Error).message,
    });
  }
}
