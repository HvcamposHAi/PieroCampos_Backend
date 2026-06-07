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
    /** Operador ativo resolvido por `exigirOperadorAtivo` (evita 2º lookup). */
    operador?: OperadorAtivo;
    /** Corretora EFETIVA resolvida por `exigirCorretoraSelecionada` (isolamento). */
    corretoraId?: string;
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

/**
 * Exige perfil admin E popula `req.operador` (corretora_id/is_plataforma/ativa)
 * para os handlers usarem `corretoraEfetiva(req.operador)` sem novo round-trip.
 */
export async function exigirAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const op = await carregarOperadorAtivo(req);
  if (!op || op.perfil !== "admin") {
    res.status(403).json({ erro: "admin_required" });
    return;
  }
  req.operador = op;
  next();
}

/**
 * Exige super-admin de PLATAFORMA (is_plataforma=true). Defesa real das rotas
 * /api/plataforma/* (não confiar na UI). Popula req.operador.
 */
export async function exigirPlataforma(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const op = await carregarOperadorAtivo(req);
  if (!op || !op.is_plataforma) {
    res.status(403).json({ erro: "plataforma_required" });
    return;
  }
  req.operador = op;
  next();
}

/**
 * Exige uma corretora EFETIVA selecionada e a publica em `req.corretoraId`. Usar
 * APÓS exigirAdmin/exigirOperadorAtivo (que populam req.operador) nas rotas que
 * leem/escrevem dados-tenant. Super-admin em "Todas" (sem seleção) → 409 para a
 * UI pedir que escolha uma corretora. Admin normal nunca cai no 409.
 */
export async function exigirCorretoraSelecionada(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const op = req.operador ?? (await carregarOperadorAtivo(req));
  if (!op) {
    res.status(403).json({ erro: "operador_required" });
    return;
  }
  req.operador = op;
  const corretoraId = corretoraEfetiva(op);
  if (!corretoraId) {
    res.status(409).json({
      erro: "corretora_nao_selecionada",
      mensagem: "Selecione uma corretora no topo para gerenciar.",
    });
    return;
  }
  req.corretoraId = corretoraId;
  next();
}

export interface OperadorAtivo {
  id: string;
  perfil: string;
  /** Linha WhatsApp que o operador opera (escolhida na página móvel /bot). */
  canal_padrao_id: string | null;
  /** Corretora (tenant) do operador. Isolamento de dados no backend gira por aqui. */
  corretora_id: string;
  /** Super-admin de plataforma: enxerga/gerencia TODAS as corretoras. */
  is_plataforma: boolean;
  /** Corretora que o super-admin "entrou" (NULL = ver todas). Só p/ is_plataforma. */
  corretora_ativa_id: string | null;
}

/**
 * Corretora EFETIVA para ESCRITAS do backend: super-admin usa a corretora que
 * "entrou" (corretora_ativa_id); demais usam a sua. Retorna null se o super-admin
 * não selecionou nenhuma (rotas de escrita escopada devem então responder 400).
 */
export function corretoraEfetiva(op: OperadorAtivo): string | null {
  return op.is_plataforma ? op.corretora_ativa_id : op.corretora_id;
}

/**
 * Carrega o operador ATIVO vinculado ao req.user (via operadores.supabase_user_id,
 * NÃO operadores.id — ver memória rls-perfil-operador-arquitetura). Retorna null
 * se não houver vínculo ativo. Base para autorização escopada por conversa E por
 * corretora (multi-tenant). `corretora_id`/`is_plataforma` entram no select via
 * cast porque só existem no types.ts após a regeneração (cláusula 2 da migração).
 */
export async function carregarOperadorAtivo(req: Request): Promise<OperadorAtivo | null> {
  if (!req.user?.id) return null;
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("operadores")
    .select("id, perfil, canal_padrao_id, corretora_id, is_plataforma, corretora_ativa_id" as never)
    .eq("supabase_user_id", req.user.id)
    .eq("ativo", true)
    .maybeSingle();
  if (error) {
    logger.warn("[auth] lookup operador ativo falhou", { erro: error.message });
    return null;
  }
  if (!data) return null;
  const row = data as unknown as {
    id: string;
    perfil: string;
    canal_padrao_id: string | null;
    corretora_id?: string | null;
    is_plataforma?: boolean | null;
    corretora_ativa_id?: string | null;
  };
  return {
    id: row.id,
    perfil: row.perfil,
    canal_padrao_id: row.canal_padrao_id,
    corretora_id: row.corretora_id ?? "",
    is_plataforma: row.is_plataforma ?? false,
    corretora_ativa_id: row.corretora_ativa_id ?? null,
  };
}

/**
 * Exige um operador ATIVO vinculado ao req.user (admin inclusive — admin é
 * operador com perfil 'admin'). Usado por ações liberadas a qualquer operador
 * (ex.: cotação manual). 403 se não houver vínculo ativo. Popula req.operador
 * para o handler reusar sem novo round-trip.
 */
export async function exigirOperadorAtivo(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const operador = await carregarOperadorAtivo(req);
  if (!operador) {
    res.status(403).json({ erro: "operador_required" });
    return;
  }
  req.operador = operador;
  next();
}
