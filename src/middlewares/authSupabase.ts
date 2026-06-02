/**
 * Middleware Express que valida o JWT vindo do front (Supabase Auth).
 *
 * Não confunde com o getSupabaseAdmin do módulo whatsapp: aqui usamos a anon
 * key apenas para chamar `auth.getUser(jwt)`, que verifica assinatura e
 * expiração. A operação real (com service_role) acontece nos handlers, após
 * o middleware popular `req.user`.
 *
 * NÃO carrega perfil aqui — handlers que exigem admin chamam isAdmin(req) em
 * tempo de uso (evita 1 round-trip em rotas que não precisam).
 */
import type { NextFunction, Request, Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "../config/env";
import { getSupabaseAdmin } from "../integrations/whatsapp/supabase";
import { logger } from "../utils/logger";

export interface UsuarioAutenticado {
  id: string;
  email: string;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: UsuarioAutenticado;
  }
}

let sbAnonCache: SupabaseClient | null = null;
function sbAnon(): SupabaseClient {
  if (sbAnonCache) return sbAnonCache;
  const env = getEnv();
  sbAnonCache = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return sbAnonCache;
}

export async function authSupabase(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) {
    res.status(401).json({ erro: "auth_missing" });
    return;
  }
  const jwt = header.slice(7);
  try {
    const { data, error } = await sbAnon().auth.getUser(jwt);
    if (error || !data?.user) {
      res.status(401).json({ erro: "auth_invalid" });
      return;
    }
    req.user = { id: data.user.id, email: data.user.email ?? "" };
    next();
  } catch (e) {
    logger.warn("[auth] erro ao validar JWT", { erro: (e as Error).message });
    res.status(401).json({ erro: "auth_error" });
  }
}

/**
 * Checa se req.user tem perfil admin. Não chama a RPC `perfil_usuario()` porque
 * essa função depende de `auth.uid()`, que é NULL quando o request vem via
 * service_role. Em vez disso, query direta em `operadores` pelo vínculo
 * `supabase_user_id` (ver memória rls-perfil-operador-arquitetura).
 */
export async function isAdmin(req: Request): Promise<boolean> {
  if (!req.user?.id) return false;
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("operadores")
    .select("perfil")
    .eq("supabase_user_id", req.user.id)
    .eq("ativo", true)
    .maybeSingle();
  if (error) {
    logger.warn("[auth] lookup operador falhou", { erro: error.message });
    return false;
  }
  return (data as { perfil?: string } | null)?.perfil === "admin";
}

export async function exigirAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (await isAdmin(req)) {
    next();
    return;
  }
  res.status(403).json({ erro: "admin_required" });
}

export interface OperadorAtivo {
  id: string;
  perfil: string;
  /** Linha WhatsApp que o operador opera (escolhida na página móvel /bot). */
  canal_padrao_id: string | null;
}

/**
 * Carrega o operador ATIVO vinculado ao req.user (via operadores.supabase_user_id,
 * NÃO operadores.id — ver memória rls-perfil-operador-arquitetura). Retorna null
 * se não houver vínculo ativo. Base para autorização escopada por conversa.
 */
export async function carregarOperadorAtivo(req: Request): Promise<OperadorAtivo | null> {
  if (!req.user?.id) return null;
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("operadores")
    .select("id, perfil, canal_padrao_id")
    .eq("supabase_user_id", req.user.id)
    .eq("ativo", true)
    .maybeSingle();
  if (error) {
    logger.warn("[auth] lookup operador ativo falhou", { erro: error.message });
    return null;
  }
  return (data as OperadorAtivo | null) ?? null;
}
