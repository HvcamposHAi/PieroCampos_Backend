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
  porEmail?: string | null;
}): Promise<void> {
  const corretoraId = input.corretoraId ?? CORRETORA_SEED_ID;
  const sb = getSupabaseAdmin();
  const senha_cifrada = cifrar(input.senha); // {iv,tag,ciphertext}
  // Por-corretora: 1 linha por corretora (UNIQUE(corretora_id) — cláusula 13).
  // id (PK text) = corretoraId; onConflict no corretora_id atualiza a existente.
  const { error } = await sb.from("segfy_credenciais").upsert(
    {
      id: corretoraId,
      corretora_id: corretoraId,
      email: input.email,
      senha_cifrada,
      atualizado_por: input.porEmail ?? null,
      atualizado_em: new Date().toISOString(),
    } as never,
    { onConflict: "corretora_id" },
  );
  if (error) throw new Error(`salvarCredenciaisSegfy: ${error.message}`);
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
        "email, atualizado_em, atualizado_por, ultimo_teste_em, ultimo_teste_ok, ultimo_teste_msg",
      )
      .eq("corretora_id" as never, corretoraId as never)
      .maybeSingle();
    const linha = data as Omit<LinhaCredenciais, "senha_cifrada"> | null;
    if (linha?.email) {
      return {
        configurado: true,
        fonte: "db",
        email: linha.email,
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
    atualizado_em: null,
    atualizado_por: null,
    ultimo_teste_em: null,
    ultimo_teste_ok: null,
    ultimo_teste_msg: null,
  };
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
