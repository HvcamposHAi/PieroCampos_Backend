/**
 * Orquestrador da EMISSÃO de apólice (operador dispara após proposta `aprovada`).
 *
 * Passos: carrega a proposta (exige 'aprovada' + escopo da corretora) → resolve a
 * `seguradoras_config` (por nome) → resolve credenciais do cofre → escolhe o
 * provider por grupo (api/rpa/rpa+otp) → emite → sobe o PDF → persiste a apólice e
 * marca a proposta 'emitida'. Observabilidade via `cotacao_eventos` (realtime).
 *
 * Injetável (deps) para teste: `persist` (InMemory) e `provider` (fake) substituem
 * o Supabase/Playwright. O gate APOLICE_ENABLED é checado na ROTA (não aqui), para
 * manter este service livre de getEnv() nos testes.
 */
import { SupabasePersistence } from "../integrations/persistence/supabase-persistence";
import type { PersistencePort } from "../integrations/segfy/persistence.port";
import type { ApoliceProvider, CredenciaisPortal } from "../integrations/apolice/apolice-provider.port";
import { getApoliceProvider } from "../integrations/apolice/registry";
import { subirApolicePdf } from "../integrations/apolice/apolice-storage";
import { obterCredenciaisPortal } from "./seguradora-credenciais.service";
import { rowParaRef } from "./seguradoras-config.service";
import { logger } from "../utils/logger";

export interface EmitirApoliceArgs {
  propostaId: string;
  corretoraId: string;
  operadorEmail?: string | null;
}

export interface EmitirApoliceDeps {
  persist?: PersistencePort;
  /** Force um provider (teste injeta um fake). Default: resolvido por grupo. */
  provider?: ApoliceProvider;
  /** Resolve credenciais (teste injeta). Default: cofre `seguradora_credenciais`. */
  resolverCredenciais?: (args: { seguradoraConfigId: string; corretoraId: string }) => Promise<CredenciaisPortal | null>;
}

export type ResultadoEmissao = { apoliceId: string } | { erro: string };

export async function emitirApolice(
  args: EmitirApoliceArgs,
  deps: EmitirApoliceDeps = {},
): Promise<ResultadoEmissao> {
  const persist = deps.persist ?? new SupabasePersistence(undefined, args.corretoraId);

  const proposta = await persist.buscarProposta(args.propostaId);
  if (!proposta) return { erro: "proposta_nao_encontrada" };
  if (proposta.status !== "aprovada") return { erro: "proposta_nao_aprovada" };

  const segRow = await persist.buscarSeguradoraConfigPorNome(proposta.seguradora);
  if (!segRow) return { erro: "seguradora_desconhecida" };
  const ref = rowParaRef(segRow, args.corretoraId);
  const ramo = proposta.ramo ?? "auto";

  await persist.registrarEtapa({
    cotacaoId: proposta.cotacaoId,
    conversaId: null,
    etapa: "proposta",
    status: "andamento",
    mensagem: `Emitindo apólice na ${ref.nomeDisplay} (${ref.grupoIntegracao}).`,
  });

  // Credenciais: A_api pode não exigir login de portal; B_rpa/C_otp exigem.
  let credenciais: CredenciaisPortal = { usuario: "", senha: "" };
  if (ref.grupoIntegracao !== "A_api") {
    const resolver = deps.resolverCredenciais ?? obterCredenciaisPortal;
    const cred = await resolver({ seguradoraConfigId: ref.id, corretoraId: args.corretoraId });
    if (!cred) {
      await persist.registrarEtapa({
        cotacaoId: proposta.cotacaoId,
        conversaId: null,
        etapa: "login",
        status: "erro",
        mensagem: "Credencial do portal não cadastrada.",
      });
      return { erro: "sem_credencial" };
    }
    credenciais = cred;
  }

  const provider = deps.provider ?? getApoliceProvider(ref);

  // C_otp: seam de OTP. Leitura da caixa `email_otp` ainda não implementada →
  // erro claro quando o desafio aparece (premissa P/risco OTP). Sem desafio, no-op.
  const obterOtp =
    ref.grupoIntegracao === "C_otp"
      ? async (): Promise<string> => {
          throw new Error("otp_indisponivel");
        }
      : undefined;

  const resultado = await provider.emitir(
    {
      corretoraId: args.corretoraId,
      seguradora: ref,
      proposta: {
        id: proposta.id,
        numeroProposta: proposta.numeroProposta,
        clienteId: proposta.clienteId,
        ramo,
        cotacaoId: proposta.cotacaoId,
      },
      credenciais,
      obterOtp,
    },
    persist,
  );

  if (!resultado.sucesso || !resultado.numeroApolice) {
    await persist.registrarEtapa({
      cotacaoId: proposta.cotacaoId,
      conversaId: null,
      etapa: "emissao",
      status: "erro",
      mensagem: `Falha na emissão (${resultado.erro ?? "sem_numero_apolice"}).`,
    });
    await persist.registrarLog({
      operacao: "apolice",
      via: ref.grupoIntegracao === "A_api" ? "api" : "scraper",
      refId: proposta.id,
      sucesso: false,
      detalhe: { erro: resultado.erro ?? "sem_numero_apolice", seguradora: ref.nomeDisplay },
    });
    return { erro: resultado.erro ?? "emissao_falhou" };
  }

  // PDF → bucket privado (best-effort; apólice persiste mesmo sem PDF).
  let pdfUrl: string | null = null;
  if (resultado.pdf) {
    const up = await subirApolicePdf({
      corretoraId: args.corretoraId,
      propostaId: proposta.id,
      bytes: resultado.pdf.bytes,
      contentType: resultado.pdf.contentType,
    });
    pdfUrl = up?.path ?? null;
  }

  const { apoliceId } = await persist.salvarApolice({
    clienteId: proposta.clienteId,
    propostaId: proposta.id,
    numeroApolice: resultado.numeroApolice,
    ramo,
    seguradora: ref.nomeDisplay,
    inicioVigencia: resultado.inicioVigencia,
    fimVigencia: resultado.fimVigencia,
    premioTotal: resultado.premioTotal,
    premioLiquido: resultado.premioLiquido,
    pdfUrl,
  });

  // Proposta → 'emitida' (guard de idempotência aprovada→emitida no adapter).
  await persist.atualizarPropostaStatus(proposta.id, {
    status: "emitida",
    pdfUrl,
    emitidaEm: new Date().toISOString(),
  });

  await persist.registrarEtapa({
    cotacaoId: proposta.cotacaoId,
    conversaId: null,
    etapa: "download",
    status: "ok",
    mensagem: `Apólice ${resultado.numeroApolice} emitida.`,
  });
  await persist.registrarLog({
    operacao: "apolice",
    via: ref.grupoIntegracao === "A_api" ? "api" : "scraper",
    refId: apoliceId,
    sucesso: true,
    detalhe: { seguradora: ref.nomeDisplay, numeroApolice: resultado.numeroApolice },
  });

  logger.info("[apolice.emissao] apólice emitida", { propostaId: proposta.id, apoliceId });
  return { apoliceId };
}
