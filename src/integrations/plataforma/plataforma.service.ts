/**
 * Gestão de CORRETORAS (tenants) pelo SUPER-ADMIN de plataforma. Tudo aqui é
 * gated por `exigirPlataforma` (ver routes). Usa service_role (bypassa RLS).
 *
 * Onboarding de uma corretora = criar a `corretoras` + criar o 1º admin dela
 * (reusa `criarUsuario` do módulo usuarios, com corretoraId = a nova corretora).
 * "Entrar numa corretora" = gravar `operadores.corretora_ativa_id` do super-admin;
 * o RLS (corretora_efetiva()) reescopa as leituras do front automaticamente.
 *
 * `corretoras` é tabela NOVA (fora do types.ts até a regeneração) → cliente
 * destipado para acessá-la sem brigar com o Database generic.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "../whatsapp/supabase";
import { logger } from "../../utils/logger";
import { criarUsuario, type UsuarioAdmin } from "../usuarios/usuarios.service";

function sbUntyped(): SupabaseClient {
  return getSupabaseAdmin() as unknown as SupabaseClient;
}

export interface Corretora {
  id: string;
  nome: string;
  slug: string | null;
  ativo: boolean;
  plano: string | null;
  criado_em: string;
}

export class ErroPlataforma extends Error {
  constructor(public readonly codigo: "nao_encontrado" | "slug_existe", mensagem: string) {
    super(mensagem);
    this.name = "ErroPlataforma";
  }
}

const COLS = "id, nome, slug, ativo, plano, criado_em";

export async function listarCorretoras(): Promise<Corretora[]> {
  const { data, error } = await sbUntyped()
    .from("corretoras")
    .select(COLS)
    .order("criado_em", { ascending: true });
  if (error) throw new Error(`listarCorretoras: ${error.message}`);
  return (data ?? []) as unknown as Corretora[];
}

export async function criarCorretora(input: {
  nome: string;
  slug?: string | null;
  plano?: string | null;
}): Promise<Corretora> {
  const payload: Record<string, unknown> = { nome: input.nome.trim(), ativo: true };
  if (input.slug) payload.slug = input.slug.trim().toLowerCase();
  if (input.plano) payload.plano = input.plano.trim();
  const { data, error } = await sbUntyped()
    .from("corretoras")
    .insert(payload as never)
    .select(COLS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ErroPlataforma("slug_existe", "Já existe uma corretora com este slug.");
    }
    throw new Error(`criarCorretora: ${error.message}`);
  }
  logger.info("[plataforma] corretora criada", { nome: input.nome });
  return data as unknown as Corretora;
}

/** Cria o 1º admin (login+senha) de uma corretora existente. */
export async function criarAdminCorretora(input: {
  corretoraId: string;
  nome: string;
  email: string;
  senha: string;
  porEmail?: string | null;
}): Promise<UsuarioAdmin> {
  // Garante que a corretora existe (evita órfão).
  const { data: cor, error } = await sbUntyped()
    .from("corretoras")
    .select("id")
    .eq("id", input.corretoraId)
    .maybeSingle();
  if (error) throw new Error(`criarAdminCorretora.load: ${error.message}`);
  if (!cor) throw new ErroPlataforma("nao_encontrado", "Corretora não encontrada.");

  return criarUsuario({
    nome: input.nome,
    email: input.email,
    perfil: "admin",
    ativo: true,
    senha: input.senha,
    corretoraId: input.corretoraId,
    porEmail: input.porEmail ?? null,
  });
}

/** Define a corretora "ativa" do super-admin (null = ver todas). */
export async function definirCorretoraAtiva(input: {
  operadorId: string;
  corretoraId: string | null;
}): Promise<{ corretora_ativa_id: string | null }> {
  if (input.corretoraId) {
    const { data: cor, error } = await sbUntyped()
      .from("corretoras")
      .select("id")
      .eq("id", input.corretoraId)
      .maybeSingle();
    if (error) throw new Error(`definirCorretoraAtiva.load: ${error.message}`);
    if (!cor) throw new ErroPlataforma("nao_encontrado", "Corretora não encontrada.");
  }
  const { error } = await sbUntyped()
    .from("operadores")
    .update({ corretora_ativa_id: input.corretoraId, atualizado_em: new Date().toISOString() } as never)
    .eq("id", input.operadorId);
  if (error) throw new Error(`definirCorretoraAtiva.update: ${error.message}`);
  logger.info("[plataforma] corretora ativa definida", {
    operadorId: input.operadorId,
    corretoraId: input.corretoraId,
  });
  return { corretora_ativa_id: input.corretoraId };
}
