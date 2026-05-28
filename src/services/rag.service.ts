/**
 * RAG (Retrieval Augmented Generation) — busca contexto do cliente no Supabase
 * para que a Bia não pergunte coisas que já sabemos.
 *
 * Fontes:
 *   - clientes (dados cadastrais)
 *   - apolices (últimas 3, qualquer ramo)
 *   - conversas (últimas 2, fora a atual, qualquer estado != encerrado/atual)
 *
 * Sem embeddings nesta fase (ver §7.4 da spec). É puro SQL, sem chamada externa.
 * Tudo via service_role para bypassar RLS.
 */
import { getSupabaseAdmin } from "../integrations/whatsapp/supabase";
import { logger } from "../utils/logger";

export interface ClienteRAG {
  id: string;
  nome: string | null;
  email: string | null;
  estado_civil: string | null;
  endereco: unknown;
  consentimento_lgpd: boolean;
  atendimento_vip: boolean;
}

export interface ApoliceRAG {
  numero_apolice: string;
  seguradora: string;
  ramo: string;
  inicio_vigencia: string;
  fim_vigencia: string;
  premio_total: number | null;
}

export interface ConversaAnteriorRAG {
  id: string;
  criado_em: string;
  categoria: string | null;
  estado: string;
  dados_coletados: Record<string, unknown>;
}

export interface ContextoRAG {
  cliente: ClienteRAG | null;
  apolices: ApoliceRAG[];
  conversasAnteriores: ConversaAnteriorRAG[];
}

export async function buscarContextoRAG(input: {
  clienteId: string;
  conversaAtualId: string;
}): Promise<ContextoRAG> {
  const sb = getSupabaseAdmin();

  const [cliRes, apoRes, convRes] = await Promise.all([
    sb
      .from("clientes")
      .select("id, nome, email, estado_civil, endereco, consentimento_lgpd, atendimento_vip")
      .eq("id", input.clienteId)
      .maybeSingle(),
    sb
      .from("apolices")
      .select("numero_apolice, seguradora, ramo, inicio_vigencia, fim_vigencia, premio_total")
      .eq("cliente_id", input.clienteId)
      .is("deletado_em", null)
      .order("fim_vigencia", { ascending: false })
      .limit(3),
    sb
      .from("conversas")
      .select("id, criado_em, categoria, estado, dados_coletados")
      .eq("cliente_id", input.clienteId)
      .neq("id", input.conversaAtualId)
      .is("deletado_em", null)
      .order("criado_em", { ascending: false })
      .limit(2),
  ]);

  if (cliRes.error) logger.warn("[rag] erro lendo cliente", { erro: cliRes.error.message });
  if (apoRes.error) logger.warn("[rag] erro lendo apolices", { erro: apoRes.error.message });
  if (convRes.error) logger.warn("[rag] erro lendo conversas", { erro: convRes.error.message });

  return {
    cliente: (cliRes.data as ClienteRAG | null) ?? null,
    apolices: (apoRes.data as ApoliceRAG[] | null) ?? [],
    conversasAnteriores: (convRes.data as ConversaAnteriorRAG[] | null) ?? [],
  };
}

function primeiroNome(nome: string | null): string {
  if (!nome) return "";
  return nome.trim().split(/\s+/)[0] ?? "";
}

/**
 * Serializa o contexto em texto plano para injetar no system prompt.
 * Quanto menor e mais relevante, melhor — não jogar JSON cru.
 */
export function montarContextoRAG(rag: ContextoRAG): string {
  const partes: string[] = [];

  if (rag.cliente) {
    const c = rag.cliente;
    partes.push("DADOS DO CLIENTE:");
    partes.push(`- Nome: ${c.nome ?? "(não cadastrado)"}`);
    if (c.nome) partes.push(`- Primeiro nome para tratamento: ${primeiroNome(c.nome)}`);
    if (c.email) partes.push(`- E-mail: ${c.email}`);
    if (c.estado_civil) partes.push(`- Estado civil: ${c.estado_civil}`);
    if (c.endereco) partes.push(`- Endereço: ${JSON.stringify(c.endereco)}`);
    partes.push(`- Consentimento LGPD: ${c.consentimento_lgpd ? "sim" : "ainda não registrado"}`);
    if (c.atendimento_vip) partes.push("- ⚠️ Cliente VIP — bot não pode atender; transferir direto.");
  } else {
    partes.push("DADOS DO CLIENTE: cliente novo, sem cadastro.");
  }

  if (rag.apolices.length > 0) {
    partes.push("");
    partes.push("APÓLICES (últimas):");
    for (const a of rag.apolices) {
      const premio = a.premio_total != null ? ` R$ ${a.premio_total}` : "";
      partes.push(
        `- ${a.ramo} • ${a.seguradora} • nº ${a.numero_apolice} • vigência ${a.inicio_vigencia} a ${a.fim_vigencia}${premio}`,
      );
    }
  }

  if (rag.conversasAnteriores.length > 0) {
    partes.push("");
    partes.push("CONTATOS ANTERIORES:");
    for (const c of rag.conversasAnteriores) {
      const dados = Object.keys(c.dados_coletados ?? {});
      partes.push(
        `- ${c.criado_em.slice(0, 10)} • categoria=${c.categoria ?? "?"} • estado=${c.estado} • já coletado: [${dados.join(", ") || "—"}]`,
      );
    }
  }

  return partes.join("\n");
}
