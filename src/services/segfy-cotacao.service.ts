/**
 * Ponte bot → Segfy. Isola o disparo de cotação (e o mapeamento dos
 * `dados_coletados` da conversa para o payload do SegfyClient) do bot.service,
 * mantendo o mapeamento puro e testável.
 *
 * Regras de segurança:
 *   - Só dispara se SEGFY_ENABLED=true (caso contrário, no-op silencioso).
 *   - A guarda de consentimento LGPD vive dentro do SegfyClient.
 *   - Falha do Segfy NUNCA quebra o fluxo do bot: logamos e retornamos null;
 *     a conversa permanece em `aguardando_cotacao` e a equipe assume.
 */
import { getEnv } from "../config/env";
import type { DadosFormularioPiero } from "../integrations/segfy/segfy.client";
import { SegfyClient } from "../integrations/segfy/segfy.client";
import { formatarComparativoParaWhatsApp } from "../integrations/segfy/segfy.format";
import { SupabasePersistence } from "../integrations/persistence/supabase-persistence";
import { logger } from "../utils/logger";

function asString(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  if (typeof v === "number") return String(v);
  return undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[^\d.,-]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["sim", "true", "1", "yes"].includes(s)) return true;
    if (["nao", "não", "false", "0", "no"].includes(s)) return false;
  }
  return undefined;
}

/**
 * Mapeia o registro solto `dados_coletados` para o payload tipado do Segfy.
 * Função PURA (sem I/O) — coberta por teste unitário.
 */
export function mapearDadosParaSegfy(dados: Record<string, unknown>): DadosFormularioPiero {
  return {
    nome: asString(dados.nome) ?? "",
    cpf: asString(dados.cpf),
    email: asString(dados.email),
    telefone: asString(dados.telefone),
    estado_civil: asString(dados.estado_civil),
    data_nascimento: asString(dados.data_nascimento),
    cep: asString(dados.cep),
    fipe_codigo: asString(dados.fipe_codigo),
    marca: asString(dados.marca),
    modelo: asString(dados.modelo),
    ano_modelo: asNumber(dados.ano_modelo),
    ano_fabricacao: asNumber(dados.ano_fabricacao),
    uso_veiculo: asString(dados.uso_veiculo),
    garagem: asString(dados.garagem),
    alienado: asBoolean(dados.alienado),
    zero_km: asBoolean(dados.zero_km),
    bonus_atual: asNumber(dados.bonus_atual),
    comissao_percentual: asNumber(dados.comissao_percentual),
  };
}

/**
 * Dispara a cotação no Segfy e devolve o texto do comparativo pronto para o
 * WhatsApp, ou `null` quando: a flag está desligada, ou houve qualquer falha
 * (sempre não-fatal para o bot).
 */
export async function dispararCotacaoSegfy(params: {
  conversaId: string;
  clienteId: string;
  dados: Record<string, unknown>;
}): Promise<{ texto: string } | null> {
  const env = getEnv();
  if (!env.SEGFY_ENABLED) {
    logger.info("[segfy] SEGFY_ENABLED=false; mantendo aguardando_cotacao", {
      conversaId: params.conversaId,
    });
    return null;
  }

  try {
    const dadosForm = mapearDadosParaSegfy(params.dados);
    const client = new SegfyClient(new SupabasePersistence());
    const resultado = await client.processarFormularioAuto({
      conversaId: params.conversaId,
      clienteId: params.clienteId,
      dados: dadosForm,
    });
    const texto = formatarComparativoParaWhatsApp(
      resultado.resultados,
      dadosForm.nome || "tudo certo",
    );
    return { texto };
  } catch (e) {
    logger.error("[segfy] cotação falhou (não-fatal)", {
      conversaId: params.conversaId,
      erro: (e as Error).message,
    });
    return null;
  }
}
