/**
 * Ponte bot → Segfy (multicálculo Auto). Mapeia os `dados_coletados` da conversa
 * (roteiro da Bia) para a entrada da API do Segfy, respeitando as ÁRVORES DE
 * DECISÃO do formulário (uso, garagem trabalho/estudo, condutor adicional) e os
 * mapas de enum PT→Segfy. Dispara via `cotarAuto` (HTTP, sem browser) e persiste.
 *
 * Regras:
 *   - Só dispara com SEGFY_ENABLED=true e consentimento_lgpd (guarda no bot).
 *   - Sem CPF (do cliente) ou sem placa (do veículo) → não cota (faltando[]).
 *   - Falha do Segfy nunca quebra o bot: loga e retorna null.
 *
 * ⚠️ Enums confirmados: "single", "personal"/"particular", garagens/residência/
 * isenção dos defaults. Os demais (married/divorced/app/work...) são BEST-GUESS
 * até capturar a tabela de valores do form — ver MAP_* (fácil de corrigir).
 */
import { getEnv } from "../config/env";
import {
  cotarAuto,
  type DadosCotacaoAuto,
  type QuestionarioSegfy,
} from "../integrations/segfy/segfy.multicalculo";
import { formatarComparativoParaWhatsApp } from "../integrations/segfy/segfy.format";
import { SupabasePersistence } from "../integrations/persistence/supabase-persistence";
import { logger } from "../utils/logger";

const VALIDADE_COTACAO_MS = 7 * 24 * 60 * 60 * 1000;

// ---- helpers de coerção -----------------------------------------------------
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
function ehSim(v: unknown): boolean | undefined {
  const s = asString(v)?.toLowerCase();
  if (s == null) return undefined;
  if (["sim", "true", "1", "yes", "tem", "possui"].includes(s)) return true;
  if (["nao", "não", "false", "0", "no", "nenhum"].includes(s)) return false;
  return undefined;
}

// ---- mapas de enum (PT → Segfy). ✓ = confirmado; demais = best-guess. -------
const MAP_ESTADO_CIVIL: Record<string, string> = {
  solteiro: "single", // ✓
  casado: "married",
  divorciado: "divorced",
  separado: "separated",
  viuvo: "widowed",
  uniao_estavel: "stable_union",
};
/** uso → { category_type, utilization_type } */
const MAP_USO: Record<string, { category_type: string; utilization_type: string }> = {
  particular: { category_type: "particular", utilization_type: "personal" }, // ✓
  trabalho: { category_type: "particular", utilization_type: "work" },
  aplicativo: { category_type: "app", utilization_type: "app" },
  app: { category_type: "app", utilization_type: "app" },
  uber: { category_type: "app", utilization_type: "app" },
};
const MAP_RESIDENCIA: Record<string, string> = { casa: "house", apartamento: "apartment", ap: "apartment", condominio: "apartment" };

/** Extrai a placa de um campo `placa` ou do texto livre `dados_veiculo_fipe`. */
function extrairPlaca(dados: Record<string, unknown>): string | undefined {
  const direto = asString(dados.placa);
  const texto = `${direto ?? ""} ${asString(dados.dados_veiculo_fipe) ?? ""}`;
  const achado = /([A-Za-z]{3}[-\s]?\d[A-Za-z0-9]\d{2})/.exec(texto.replace(/\s+/g, " "))?.[1];
  return achado ? achado.replace(/[-\s]/g, "").toUpperCase() : undefined;
}

export interface EntradaMapeada {
  entrada: DadosCotacaoAuto | null;
  faltando: string[];
}

/**
 * Mapeia `dados_coletados` + cliente → entrada do Segfy, aplicando as árvores de
 * decisão. PURO (sem I/O) — coberto por teste.
 */
export function mapearParaCotacao(
  dados: Record<string, unknown>,
  cliente: { cpf: string | null; nome?: string | null },
): EntradaMapeada {
  const faltando: string[] = [];
  const cpf = asString(cliente.cpf)?.replace(/\D/g, "");
  const placa = extrairPlaca(dados);
  const cep = asString(dados.cep) ?? asString(dados.endereco);
  if (!cpf) faltando.push("cpf (cadastro do cliente)");
  if (!placa) faltando.push("placa do veículo");
  if (!cep) faltando.push("cep");
  if (!cpf || !placa || !cep) return { entrada: null, faltando };

  // Questionário (árvores de decisão) — só sobrescreve o padrão quando há resposta.
  const q: Partial<QuestionarioSegfy> = {};
  const garagemCasa = ehSim(dados.garagem) ?? ehSim(dados.garagem_residencia);
  if (garagemCasa != null) q.residence_garage = garagemCasa ? "yes_with_electronic_gate" : "no";
  // job_garage só faz sentido se trabalha; study_garage só se estuda.
  if (ehSim(dados.trabalha)) q.job_garage = ehSim(dados.garagem_trabalho) ? "yes" : "no";
  if (ehSim(dados.estuda)) q.study_garage = ehSim(dados.garagem_estudo) ? "yes" : "no";
  const kmMes = asNumber(dados.km_mes);
  if (kmMes != null) q.monthly_km = String(kmMes);
  const dist = asNumber(dados.distancia_trabalho);
  if (dist != null) q.work_distance = String(dist);
  const tipoResid = asString(dados.tipo_residencia)?.toLowerCase();
  if (tipoResid && MAP_RESIDENCIA[tipoResid]) q.residence_type = MAP_RESIDENCIA[tipoResid];
  const outroCondutor = ehSim(dados.outro_condutor);
  if (outroCondutor != null) {
    q.other_driver = outroCondutor ? "exists" : "does_not_exist";
    const idade = asNumber(dados.idade_condutor_secundario);
    if (outroCondutor && idade != null) q.secondary_driver_age = String(idade);
  }
  if (ehSim(dados.isencao_fiscal) != null) q.tax_exemption = ehSim(dados.isencao_fiscal) ? "isent" : "not_isent";

  // uso → category_type / utilization_type
  const usoKey = asString(dados.utilizacao_veiculo)?.toLowerCase();
  const uso = usoKey ? MAP_USO[usoKey] : undefined;
  if (uso) q.utilization_type = uso.utilization_type;

  const estadoCivilKey = asString(dados.estado_civil)?.toLowerCase();

  const entrada: DadosCotacaoAuto = {
    cpf,
    placa,
    cep: cep.replace(/\D/g, ""),
    profissao: asString(dados.profissao),
    maritalStatus: estadoCivilKey ? MAP_ESTADO_CIVIL[estadoCivilKey] : undefined,
    categoryType: uso?.category_type,
    bonus: asNumber(dados.bonus),
    questionario: Object.keys(q).length ? q : undefined,
  };
  return { entrada, faltando: [] };
}

/**
 * Dispara a cotação no Segfy e devolve o texto do comparativo pronto p/ WhatsApp,
 * ou null (flag off, faltam dados, ou falha — sempre não-fatal p/ o bot).
 */
export async function dispararCotacaoSegfy(params: {
  conversaId: string;
  clienteId: string;
  dados: Record<string, unknown>;
}): Promise<{ texto: string } | null> {
  const env = getEnv();
  if (!env.SEGFY_ENABLED) {
    logger.info("[segfy] SEGFY_ENABLED=false; mantendo aguardando_cotacao", { conversaId: params.conversaId });
    return null;
  }

  try {
    const persist = new SupabasePersistence();
    const cliente = await persist.buscarClientePorId(params.clienteId);
    if (!cliente) {
      logger.warn("[segfy] cliente não encontrado", { conversaId: params.conversaId });
      return null;
    }
    if (!cliente.consentimento_lgpd) {
      logger.warn("[segfy] sem consentimento LGPD — não cotar", { conversaId: params.conversaId });
      return null;
    }

    const { entrada, faltando } = mapearParaCotacao(params.dados, cliente);
    if (!entrada) {
      logger.warn("[segfy] dados insuficientes para cotar", { conversaId: params.conversaId, faltando });
      return null;
    }

    const { quotationId, resultados } = await cotarAuto(entrada);

    await persist.salvarCotacao({
      conversaId: params.conversaId,
      clienteId: params.clienteId,
      ramo: "auto",
      dadosEntrada: { ...params.dados, placa: entrada.placa },
      resultados,
      segfyCotacaoId: quotationId ?? `cot_${Date.now()}`,
      validadeAte: new Date(Date.now() + VALIDADE_COTACAO_MS).toISOString(),
    });
    await persist.registrarLog({
      operacao: "cotacao",
      via: "api",
      refId: quotationId ?? undefined,
      sucesso: resultados.some((r) => r.status === "cotado"),
      detalhe: { total: resultados.length, cotadas: resultados.filter((r) => r.status === "cotado").length },
    });

    const nome =
      asString(params.dados.nome) ?? asString(params.dados.segurado) ?? cliente.nome ?? "tudo certo";
    return { texto: formatarComparativoParaWhatsApp(resultados, nome) };
  } catch (e) {
    logger.error("[segfy] cotação falhou (não-fatal)", {
      conversaId: params.conversaId,
      erro: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
