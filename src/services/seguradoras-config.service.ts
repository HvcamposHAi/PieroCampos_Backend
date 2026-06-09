/**
 * Camada de serviço do catálogo de seguradoras (tela /seguradoras + Admin). Lê/
 * escreve via SupabasePersistence (service_role, escopo por corretora). O botão
 * "Testar" é a ÚNICA coisa que muda `status_acesso` (decisão do produto): faz um
 * login de verificação (API ping p/ A_api; Playwright p/ B_rpa/C_otp) e registra
 * ok/falha + `ultimo_acesso`. Falha de cotação/emissão NÃO rebaixa status aqui.
 */
import { SupabasePersistence } from "../integrations/persistence/supabase-persistence";
import type {
  AtualizarSeguradoraConfigInput,
  SeguradoraConfigRow,
} from "../integrations/segfy/persistence.port";
import type { SeguradoraConfigRef } from "../integrations/apolice/apolice-provider.port";
import { testarConexaoPortal } from "../integrations/apolice/apolice.scraper";
import { testarConexaoApi } from "../integrations/apolice/apolice.api";
import { obterCredenciaisPortal } from "./seguradora-credenciais.service";
import { logger } from "../utils/logger";

/** SeguradoraConfigRow (banco) → SeguradoraConfigRef (módulo isolado). */
export function rowParaRef(row: SeguradoraConfigRow, corretoraId: string): SeguradoraConfigRef {
  return {
    id: row.id,
    corretoraId,
    nomeDisplay: row.nome_display,
    grupoIntegracao: row.grupo_integracao,
    loginType: row.login_type,
    urlPortal: row.url_portal,
    vaultKey: row.vault_key,
    emailOtp: row.email_otp,
    tipoAutenticacao: row.tipo_autenticacao,
  };
}

export async function listarSeguradorasConfig(corretoraId: string): Promise<SeguradoraConfigRow[]> {
  return new SupabasePersistence(undefined, corretoraId).listarSeguradorasConfig();
}

export async function atualizarSeguradoraConfig(
  corretoraId: string,
  id: string,
  patch: AtualizarSeguradoraConfigInput,
): Promise<void> {
  await new SupabasePersistence(undefined, corretoraId).atualizarSeguradoraConfig(id, patch);
}

export interface ResultadoTeste {
  ok: boolean;
  status_acesso: "ok" | "falha";
  ultimo_acesso: string;
  mensagem: string;
}

/**
 * "Testar" conectividade da seguradora. Resolve a config + credenciais, faz o
 * login de verificação conforme o grupo e grava o status. Sem credencial → falha
 * graciosa (status `falha`, mensagem clara) — não lança.
 */
export async function testarConectividade(corretoraId: string, id: string): Promise<ResultadoTeste> {
  const persist = new SupabasePersistence(undefined, corretoraId);
  const row = await persist.buscarSeguradoraConfigPorId(id);
  if (!row) throw new Error("seguradora_nao_encontrada");

  const ref = rowParaRef(row, corretoraId);
  let resultado: { ok: boolean; mensagem: string };

  if (ref.grupoIntegracao === "A_api") {
    resultado = await testarConexaoApi();
  } else {
    const cred = await obterCredenciaisPortal({ seguradoraConfigId: id, corretoraId });
    if (!cred) {
      resultado = { ok: false, mensagem: "Credencial não cadastrada (botão Senha)" };
    } else {
      resultado = await testarConexaoPortal(ref, cred);
    }
  }

  const quando = new Date().toISOString();
  await persist.registrarStatusAcesso(id, resultado.ok ? "ok" : "falha", quando);
  logger.info("[seg.config] teste de conectividade", { id, ok: resultado.ok });
  return {
    ok: resultado.ok,
    status_acesso: resultado.ok ? "ok" : "falha",
    ultimo_acesso: quando,
    mensagem: resultado.mensagem,
  };
}
