/**
 * Singleton do cliente Supabase com service_role para o módulo WhatsApp.
 * Bypassa RLS — usado para inserir mensagens, atualizar canais e ler/escrever
 * wa_auth_state. Não confundir com o anon client do middleware de auth (que
 * valida o JWT do front), implementado em `middlewares/authSupabase.ts`.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "../../config/env";

let cache: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (cache) return cache;
  const env = getEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase WA: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.");
  }
  cache = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cache;
}

/** Reseta cache (uso em testes). */
export function _resetSupabaseAdminCache(): void {
  cache = null;
}
