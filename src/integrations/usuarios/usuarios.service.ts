/**
 * Gestão de USUÁRIOS do portal (Admin → Operadores). Admin-only (ver routes).
 *
 * É o ÚNICO ponto do sistema que toca o Supabase Auth Admin API
 * (`auth.admin.*`) — só o backend tem a service_role; a frontend (Cloudflare)
 * não. Para logar, um usuário precisa de (1) um auth.users com SENHA e
 * (2) uma linha em `operadores` com `supabase_user_id` apontando para ele e
 * `ativo=true` (ver use-auth.ts no front e authSupabase.ts aqui).
 *
 * A senha trafega só no corpo do request (TLS) e NUNCA é logada (o logger
 * redige chaves "senha"/"password" automaticamente). `operadores.perfil` é a
 * fonte canônica de autorização (as policies usam perfil_usuario(); não há
 * dependência de user_roles — verificado em prod 01/06/2026).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "../whatsapp/supabase";
import { logger } from "../../utils/logger";

export type PerfilOperador = "admin" | "supervisor" | "operador";

export interface UsuarioAdmin {
  id: string;
  nome: string;
  email: string;
  perfil: PerfilOperador;
  ativo: boolean;
  supabase_user_id: string | null;
  criado_em: string;
}

const COLUNAS = "id, nome, email, perfil, ativo, supabase_user_id, criado_em";

/** Erro de domínio com código para o handler mapear o status HTTP. */
export class ErroUsuario extends Error {
  constructor(public readonly codigo: "email_exists" | "nao_encontrado", mensagem: string) {
    super(mensagem);
    this.name = "ErroUsuario";
  }
}

function normalizarEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Lista todos os usuários (a UI mostra "Login pendente" quando supabase_user_id é null). */
export async function listarUsuarios(): Promise<UsuarioAdmin[]> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("operadores")
    .select(COLUNAS)
    .order("criado_em", { ascending: true });
  if (error) throw new Error(`listarUsuarios: ${error.message}`);
  return (data ?? []) as UsuarioAdmin[];
}

/**
 * Força o estado final da linha `operadores` (por e-mail). O trigger
 * `on_auth_user_created` pode ter criado a linha ao nascer o auth user; este
 * upsert por `email` (UNIQUE) torna a operação idempotente e grava o vínculo
 * + perfil/nome/ativo escolhidos.
 */
async function reconciliarOperador(
  sb: SupabaseClient,
  input: { uid: string; email: string; nome: string; perfil: PerfilOperador; ativo: boolean },
): Promise<UsuarioAdmin> {
  const { data, error } = await sb
    .from("operadores")
    .upsert(
      {
        email: input.email,
        nome: input.nome,
        perfil: input.perfil,
        ativo: input.ativo,
        supabase_user_id: input.uid,
        atualizado_em: new Date().toISOString(),
      },
      { onConflict: "email" },
    )
    .select(COLUNAS)
    .single();
  if (error) throw new Error(`reconciliarOperador: ${error.message}`);
  return data as UsuarioAdmin;
}

/** Cria o login (auth.users + senha) e reconcilia a linha `operadores`. */
export async function criarUsuario(input: {
  nome: string;
  email: string;
  perfil: PerfilOperador;
  ativo: boolean;
  senha: string;
  porEmail?: string | null;
}): Promise<UsuarioAdmin> {
  const sb = getSupabaseAdmin();
  const email = normalizarEmail(input.email);
  const nome = input.nome.trim();

  const { data, error } = await sb.auth.admin.createUser({
    email,
    password: input.senha,
    email_confirm: true,
    user_metadata: { nome },
  });
  if (error) {
    const msg = error.message ?? "";
    const code = (error as { code?: string }).code;
    if (code === "email_exists" || /already.*(registered|exists)|email.*exists/i.test(msg)) {
      throw new ErroUsuario("email_exists", "Já existe um login com este e-mail.");
    }
    throw new Error(`criarUsuario.auth: ${msg}`);
  }
  const uid = data.user?.id;
  if (!uid) throw new Error("criarUsuario: auth user criado sem id");

  const operador = await reconciliarOperador(sb, {
    uid,
    email,
    nome,
    perfil: input.perfil,
    ativo: input.ativo,
  });
  logger.info("[usuarios] usuario criado", { email, perfil: input.perfil, por: input.porEmail ?? null });
  return operador;
}

/** Procura o id do auth user por e-mail (base pequena; pagina por garantia). */
async function acharAuthUserIdPorEmail(sb: SupabaseClient, email: string): Promise<string | null> {
  const alvo = normalizarEmail(email);
  const perPage = 200;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const users = data?.users ?? [];
    const achado = users.find((u) => (u.email ?? "").toLowerCase() === alvo);
    if (achado) return achado.id;
    if (users.length < perPage) break; // última página
  }
  return null;
}

/** Grava o vínculo supabase_user_id na linha de operadores (por id). */
async function vincular(sb: SupabaseClient, operadorId: string, uid: string): Promise<void> {
  const { error } = await sb
    .from("operadores")
    .update({ supabase_user_id: uid, atualizado_em: new Date().toISOString() })
    .eq("id", operadorId);
  if (error) throw new Error(`vincular: ${error.message}`);
}

/**
 * Define/redefine a senha de um usuário, cobrindo os 3 cenários:
 *  1. operador já vinculado → troca a senha (updateUserById);
 *  2. sem vínculo, mas existe auth user com o e-mail → troca senha + vincula;
 *  3. sem vínculo e sem auth user → cria o login + vincula.
 * `criouLogin=true` quando passou pelo cenário 3.
 */
export async function definirSenha(input: {
  operadorId: string;
  senha: string;
}): Promise<{ ok: true; criouLogin: boolean }> {
  const sb = getSupabaseAdmin();
  const { data: op, error } = await sb
    .from("operadores")
    .select("id, nome, email, supabase_user_id")
    .eq("id", input.operadorId)
    .maybeSingle();
  if (error) throw new Error(`definirSenha.load: ${error.message}`);
  if (!op) throw new ErroUsuario("nao_encontrado", "Usuário não encontrado.");
  const row = op as { id: string; nome: string; email: string; supabase_user_id: string | null };

  // Cenário 1: já tem login.
  if (row.supabase_user_id) {
    const { error: upErr } = await sb.auth.admin.updateUserById(row.supabase_user_id, {
      password: input.senha,
    });
    if (upErr) throw new Error(`definirSenha.update: ${upErr.message}`);
    logger.info("[usuarios] senha redefinida", { email: row.email });
    return { ok: true, criouLogin: false };
  }

  // Cenário 2: existe auth user com o e-mail (órfão) → reaproveita e vincula.
  const uidExistente = await acharAuthUserIdPorEmail(sb, row.email);
  if (uidExistente) {
    const { error: upErr } = await sb.auth.admin.updateUserById(uidExistente, {
      password: input.senha,
    });
    if (upErr) throw new Error(`definirSenha.update_orfao: ${upErr.message}`);
    await vincular(sb, row.id, uidExistente);
    logger.info("[usuarios] senha definida e auth user vinculado", { email: row.email });
    return { ok: true, criouLogin: false };
  }

  // Cenário 3: não existe → cria o login.
  const { data, error: cErr } = await sb.auth.admin.createUser({
    email: normalizarEmail(row.email),
    password: input.senha,
    email_confirm: true,
    user_metadata: { nome: row.nome },
  });
  if (cErr) throw new Error(`definirSenha.create: ${cErr.message}`);
  const novoUid = data.user?.id;
  if (!novoUid) throw new Error("definirSenha: auth user criado sem id");
  await vincular(sb, row.id, novoUid);
  logger.info("[usuarios] login criado e senha definida", { email: row.email });
  return { ok: true, criouLogin: true };
}

/** Atualiza nome/perfil/ativo do operador (não toca no login). */
export async function atualizarUsuario(input: {
  operadorId: string;
  nome?: string;
  perfil?: PerfilOperador;
  ativo?: boolean;
}): Promise<UsuarioAdmin> {
  const sb = getSupabaseAdmin();
  const patch: Record<string, unknown> = { atualizado_em: new Date().toISOString() };
  if (input.nome !== undefined) patch.nome = input.nome.trim();
  if (input.perfil !== undefined) patch.perfil = input.perfil;
  if (input.ativo !== undefined) patch.ativo = input.ativo;

  const { data, error } = await sb
    .from("operadores")
    .update(patch)
    .eq("id", input.operadorId)
    .select(COLUNAS)
    .maybeSingle();
  if (error) throw new Error(`atualizarUsuario: ${error.message}`);
  if (!data) throw new ErroUsuario("nao_encontrado", "Usuário não encontrado.");
  return data as UsuarioAdmin;
}

/** "Remover" = desativar (soft): bloqueia o login e preserva histórico/FKs. */
export async function desativarUsuario(operadorId: string): Promise<UsuarioAdmin> {
  const u = await atualizarUsuario({ operadorId, ativo: false });
  logger.info("[usuarios] usuario desativado", { email: u.email });
  return u;
}

/**
 * SELF-SERVICE (não admin): define qual linha o operador opera (página móvel
 * /bot). Grava `operadores.canal_padrao_id`. Valida que a linha existe e está
 * ATIVA. `canalId=null` limpa a escolha. Quem chama já resolveu o operadorId a
 * partir do JWT (carregarOperadorAtivo) — aqui não há checagem de dono.
 */
export async function definirCanalPadrao(input: {
  operadorId: string;
  canalId: string | null;
}): Promise<{ canal_padrao_id: string | null }> {
  const sb = getSupabaseAdmin();
  if (input.canalId) {
    const { data: canal, error: errC } = await sb
      .from("canais")
      .select("id, ativo")
      .eq("id", input.canalId)
      .maybeSingle();
    if (errC) throw new Error(`definirCanalPadrao.canal: ${errC.message}`);
    if (!canal) throw new ErroUsuario("nao_encontrado", "Linha não encontrada.");
    if (!(canal as { ativo: boolean }).ativo)
      throw new ErroUsuario("nao_encontrado", "Linha inativa.");
  }
  const { error } = await sb
    .from("operadores")
    .update({ canal_padrao_id: input.canalId, atualizado_em: new Date().toISOString() })
    .eq("id", input.operadorId);
  if (error) throw new Error(`definirCanalPadrao.update: ${error.message}`);
  logger.info("[usuarios] canal padrão definido", {
    operadorId: input.operadorId,
    canalId: input.canalId,
  });
  return { canal_padrao_id: input.canalId };
}
