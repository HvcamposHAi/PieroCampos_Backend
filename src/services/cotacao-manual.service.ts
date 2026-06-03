/**
 * Cotação MANUAL: o operador digita os dados do cliente e dispara a cotação no
 * Segfy SEM passar pelo WhatsApp. Reusa todo o pipeline existente
 * (`dispararCotacaoSegfy`) com `conversaId: null` e `origem: 'manual'`.
 *
 * Cliente: find-or-create por CPF (dígitos) — evita duplicar cadastro do mesmo
 * CPF. `clientes.telefone` é NOT NULL (vem do formulário). O consentimento LGPD
 * é afirmado pelo operador (checkbox) e gravado aqui; o gate real de envio de PII
 * ao Segfy continua em `dispararCotacaoSegfy` (não envia sem consentimento).
 *
 * NÃO há callback `enviar`: nada é entregue a nenhum WhatsApp.
 */
import { getSupabaseAdmin } from "../integrations/whatsapp/supabase";
import { dispararCotacaoSegfy } from "./segfy-cotacao.service";
import { logger } from "../utils/logger";

export interface DadosClienteManual {
  nome: string;
  telefone: string;
  cpf: string;
  email?: string | null;
}

/**
 * Encontra (por CPF, não-deletado) ou cria o cliente e garante consentimento
 * LGPD. Devolve o `clienteId`. CPF é normalizado para dígitos (consistente com
 * a gravação do bot via cliente-cpf).
 */
export async function criarOuObterClientePorCpf(input: DadosClienteManual): Promise<string> {
  const sb = getSupabaseAdmin();
  const cpfDigitos = input.cpf.replace(/\D/g, "");
  const agora = new Date().toISOString();

  const { data: achado, error: errSel } = await sb
    .from("clientes")
    .select("id, consentimento_lgpd")
    .eq("cpf", cpfDigitos)
    .is("deletado_em", null)
    .limit(1)
    .maybeSingle();
  if (errSel) {
    logger.error("[cotacao-manual] busca de cliente por CPF falhou", { codigo: errSel.code });
    throw errSel;
  }

  if (achado?.id) {
    // Reusa: garante consentimento (sem rebaixar dados já cadastrados).
    if (!achado.consentimento_lgpd) {
      const { error } = await sb
        .from("clientes")
        .update({ consentimento_lgpd: true, consentimento_em: agora } as never)
        .eq("id", achado.id);
      if (error) {
        logger.error("[cotacao-manual] update de consentimento falhou", { codigo: error.code });
        throw error;
      }
    }
    return achado.id;
  }

  const insert: Record<string, unknown> = {
    nome: input.nome.trim(),
    telefone: input.telefone.trim(),
    cpf: cpfDigitos,
    email: input.email?.trim() || null,
    consentimento_lgpd: true,
    consentimento_em: agora,
  };
  const { data, error } = await sb
    .from("clientes")
    .insert(insert as never)
    .select("id")
    .single();
  if (error || !data) {
    logger.error("[cotacao-manual] insert de cliente falhou", { codigo: error?.code });
    throw error ?? new Error("cliente_insert_sem_retorno");
  }
  return (data as { id: string }).id;
}

/**
 * Cria/obtém o cliente e dispara a cotação. Resolve assim que a cotação é criada
 * (id já existe) — o pipeline Segfy segue em background e atualiza a tela via
 * realtime, igual ao fluxo WhatsApp. Se a criação da cotação falhar (ex.: schema
 * sem `conversa_id` nullable), o erro é propagado para a rota responder 500.
 */
export async function dispararCotacaoManual(params: {
  cliente: DadosClienteManual;
  dados: Record<string, unknown>;
}): Promise<{ clienteId: string; cotacaoId: string }> {
  const clienteId = await criarOuObterClientePorCpf(params.cliente);

  const cotacaoId = await new Promise<string>((resolve, reject) => {
    let iniciada = false;
    dispararCotacaoSegfy(
      { conversaId: null, clienteId, dados: params.dados, origem: "manual" },
      undefined,
      (id) => {
        iniciada = true;
        resolve(id);
      },
    )
      .then(() => {
        if (!iniciada) reject(new Error("cotacao_sem_id"));
      })
      .catch((e) => {
        if (!iniciada) reject(e);
        else
          logger.error("[cotacao-manual] pipeline falhou pós-início", {
            clienteId,
            erro: (e as Error).message,
          });
      });
  });

  return { clienteId, cotacaoId };
}
