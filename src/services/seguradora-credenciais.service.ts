/**
 * Credenciais por SEGURADORA (portal próprio) — cifradas em `seguradora_credenciais`
 * (cláusula B). Espelha segfy-credenciais.service: a SENHA fica CIFRADA (AES-256-GCM
 * via cipher.ts, chave WA_AUTH_ENCRYPTION_KEY), acessível só pelo backend
 * (service_role). Nunca devolvemos a senha ao front nem logamos seu valor.
 *
 * A leitura do banco vive AQUI (camada de serviço) — o módulo isolado
 * `src/integrations/apolice/*` recebe a credencial como DADO (CredenciaisPortal).
 */
import { cifrar, decifrar, type PayloadCifrado } from "../integrations/whatsapp/cipher";
import { getSupabaseAdmin } from "../integrations/whatsapp/supabase";
import { logger } from "../utils/logger";
import type { CredenciaisPortal } from "../integrations/apolice/apolice-provider.port";

interface LinhaCred {
  usuario_cifrado: PayloadCifrado | null;
  senha_cifrada: PayloadCifrado | null;
  extra_cifrado: PayloadCifrado | null;
}

/** Resolve a credencial do portal de uma seguradora; null se não cadastrada/decifra falhar. */
export async function obterCredenciaisPortal(args: {
  seguradoraConfigId: string;
  corretoraId: string;
}): Promise<CredenciaisPortal | null> {
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("seguradora_credenciais")
      .select("usuario_cifrado, senha_cifrada, extra_cifrado")
      .eq("seguradora_config_id" as never, args.seguradoraConfigId as never)
      .eq("corretora_id" as never, args.corretoraId as never)
      .maybeSingle();
    if (error || !data) return null;
    const linha = data as unknown as LinhaCred;
    if (!linha.usuario_cifrado || !linha.senha_cifrada) return null;
    const usuario = decifrar<string>(linha.usuario_cifrado);
    const senha = decifrar<string>(linha.senha_cifrada);
    const extra = linha.extra_cifrado ? decifrar<Record<string, string>>(linha.extra_cifrado) : undefined;
    return { usuario, senha, extra };
  } catch (e) {
    logger.warn("[seg.cred] leitura/decifra falhou", { erro: (e as Error).message });
    return null;
  }
}

/** Cifra e grava (upsert) a credencial da seguradora. */
export async function salvarCredenciaisPortal(args: {
  seguradoraConfigId: string;
  corretoraId: string;
  usuario: string;
  senha: string;
  extra?: Record<string, string>;
  porEmail?: string | null;
}): Promise<void> {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("seguradora_credenciais").upsert(
    {
      corretora_id: args.corretoraId,
      seguradora_config_id: args.seguradoraConfigId,
      usuario_cifrado: cifrar(args.usuario),
      senha_cifrada: cifrar(args.senha),
      extra_cifrado: args.extra ? cifrar(args.extra) : null,
      atualizado_por: args.porEmail ?? null,
      atualizado_em: new Date().toISOString(),
    } as never,
    { onConflict: "corretora_id,seguradora_config_id" },
  );
  if (error) throw new Error(`salvarCredenciaisPortal: ${error.message}`);
  logger.info("[seg.cred] credenciais de portal salvas", { seguradora: args.seguradoraConfigId, por: args.porEmail });
}
