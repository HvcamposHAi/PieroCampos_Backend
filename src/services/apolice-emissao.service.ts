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
import type { ApoliceProvider, CredenciaisPortal, SeguradoraConfigRef } from "../integrations/apolice/apolice-provider.port";
import { getApoliceProvider } from "../integrations/apolice/registry";
import type { AdapterSpec } from "../integrations/descoberta/descoberta.types";
import { lerAdapterApoliceValidado } from "../integrations/descoberta/descoberta.service";
import { criarAdapterApoliceProvider } from "../integrations/apolice/apolice.adapter";
import { subirApolicePdf } from "../integrations/apolice/apolice-storage";
import { obterCredenciaisPortal } from "./seguradora-credenciais.service";
import { rowParaRef } from "./seguradoras-config.service";
import { buscarOTPEmail } from "../integrations/gmail/otp.gmail";
import { logger } from "../utils/logger";

/**
 * Domínio registrável do remetente a partir da URL do portal (p/ filtrar o OTP
 * por e-mail). Trata ccTLD de 2 níveis (.com.br, .org.br…): mantém os 3 últimos
 * rótulos; senão os 2 últimos. Ex.: ssoportais3.tokiomarine.com.br → tokiomarine.com.br.
 */
export function dominioRemetenteDeUrl(url: string | null): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const penultimo = labels[labels.length - 2];
  const doisNiveis = new Set(["com", "org", "net", "gov", "edu"]);
  const n = penultimo && doisNiveis.has(penultimo) && labels.length >= 3 ? 3 : 2;
  return labels.slice(-n).join(".");
}

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
  /** ADI: carrega o adapter VALIDADO de emissão (teste injeta). Default gated/FAIL-CLOSED. */
  lerAdapterValidado?: (corretoraId: string, seguradoraConfigId: string, ramo: string) => Promise<AdapterSpec | null>;
  /** ADI: cria o provider a partir do adapter (teste injeta). */
  criarProviderAdapter?: (spec: AdapterSpec) => ApoliceProvider;
}

/**
 * Resolve o provider de emissão: ADI primeiro (adapter VALIDADO por
 * `seguradora_config_id`, gated/FAIL-CLOSED), senão o driver legado por
 * `grupo_integracao`. `deps.provider` (teste) tem prioridade absoluta.
 */
export async function resolverProviderEmissao(
  ref: SeguradoraConfigRef,
  ramo: string,
  corretoraId: string,
  deps: EmitirApoliceDeps,
): Promise<ApoliceProvider> {
  if (deps.provider) return deps.provider;
  const ler = deps.lerAdapterValidado ?? lerAdapterApoliceValidado;
  let spec: AdapterSpec | null = null;
  try {
    spec = await ler(corretoraId, ref.id, ramo);
  } catch {
    spec = null;
  }
  if (spec) return (deps.criarProviderAdapter ?? criarAdapterApoliceProvider)(spec);
  return getApoliceProvider(ref);
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

  const provider = await resolverProviderEmissao(ref, ramo, args.corretoraId, deps);

  // C_otp: lê o código por e-mail (Gmail) filtrando pelo domínio do portal. Só é
  // chamado pelo scraper QUANDO o desafio aparece. Sem domínio resolvível ou sem
  // credenciais Gmail, buscarOTPEmail lança erro claro → emissão devolve erro.
  const obterOtp =
    ref.grupoIntegracao === "C_otp"
      ? async (): Promise<string> => {
          const dominio = dominioRemetenteDeUrl(ref.urlPortal);
          if (!dominio) throw new Error("otp_indisponivel");
          return buscarOTPEmail({ dominioRemetente: dominio });
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
