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
import type { ResultadoCotacaoItem } from "../integrations/segfy/segfy.types";
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

// ---- mapas de enum (PT → Segfy) — ✅ CONFIRMADOS no bundle do form (30/05/2026).
const MAP_ESTADO_CIVIL: Record<string, string> = {
  solteiro: "single",
  casado: "married", // "Casado(a) ou união estável"
  uniao_estavel: "married",
  divorciado: "divorced",
  separado: "divorced",
  viuvo: "widower", // ✓ é "widower" (não "widowed")
};
/** uso → { category_type, utilization_type }. utilization: personal|job|both. */
const MAP_USO: Record<string, { category_type: string; utilization_type: string }> = {
  particular: { category_type: "particular", utilization_type: "personal" },
  trabalho: { category_type: "particular", utilization_type: "personal" },
  comercial: { category_type: "particular", utilization_type: "job" },
  aplicativo: { category_type: "app_transport", utilization_type: "both" },
  app: { category_type: "app_transport", utilization_type: "both" },
  uber: { category_type: "app_transport", utilization_type: "both" },
  taxi: { category_type: "taxi", utilization_type: "both" },
};
const MAP_RESIDENCIA: Record<string, string> = {
  casa: "house",
  apartamento: "apartment",
  ap: "apartment",
  condominio: "condominium",
  chacara: "farm",
  sitio: "farm",
};

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
  // Garagem na residência: sim → portão eletrônico (default do form); não → não possui.
  const garagemCasa = ehSim(dados.garagem) ?? ehSim(dados.garagem_residencia);
  if (garagemCasa === true) q.residence_garage = "yes_with_electronic_gate";
  else if (garagemCasa === false) q.residence_garage = "no_garage";
  // Trabalho: não trabalha → does_not_work; trabalha → garagem? yes/no.
  const trabalha = ehSim(dados.trabalha);
  if (trabalha === false) q.job_garage = "does_not_work";
  else if (trabalha === true) q.job_garage = ehSim(dados.garagem_trabalho) ? "yes" : "no";
  // Estudo: não estuda → does_not_study; estuda → garagem? yes/no.
  const estuda = ehSim(dados.estuda);
  if (estuda === false) q.study_garage = "does_not_study";
  else if (estuda === true) q.study_garage = ehSim(dados.garagem_estudo) ? "yes" : "no";
  const kmMes = asNumber(dados.km_mes);
  if (kmMes != null) q.monthly_km = String(kmMes);
  const dist = asNumber(dados.distancia_trabalho);
  if (dist != null) q.work_distance = String(dist);
  const tipoResid = asString(dados.tipo_residencia)?.toLowerCase();
  if (tipoResid && MAP_RESIDENCIA[tipoResid]) q.residence_type = MAP_RESIDENCIA[tipoResid];
  // "Reside com condutores de 18 a 26 anos?" → does_not_exist | yes_female | yes_male | yes_both.
  const condutorJovem = ehSim(dados.condutor_jovem) ?? ehSim(dados.outro_condutor);
  if (condutorJovem === false) q.other_driver = "does_not_exist";
  else if (condutorJovem === true) {
    const sexo = asString(dados.sexo_condutor_jovem)?.toLowerCase();
    q.other_driver = sexo?.startsWith("f") ? "yes_female" : sexo?.startsWith("m") ? "yes_male" : "yes_both";
    const idade = asNumber(dados.idade_condutor_secundario);
    q.secondary_driver_age = idade != null && idade >= 25 ? "age_25" : "age_18_to_24";
  }
  // Isenção fiscal (PCD). ipi/icms só p/ taxi/app — não tratamos aqui.
  if (ehSim(dados.pcd) === true) q.tax_exemption = "pcd_isent";

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

export interface ResultadoDisparo {
  texto: string;
  cotacaoId: string | null;
  /** Seguradora de MENOR PREÇO (resultado destaque ao cliente), ou null. */
  maisBarata: ResultadoCotacaoItem | null;
}

/**
 * Dispara a cotação no Segfy, registrando cada ETAPA do pipeline (observabilidade)
 * e o resultado (menor preço em destaque). Devolve o texto do comparativo, ou
 * null (flag off, faltam dados, ou falha — sempre não-fatal p/ o bot).
 */
export async function dispararCotacaoSegfy(params: {
  conversaId: string;
  clienteId: string;
  dados: Record<string, unknown>;
}): Promise<ResultadoDisparo | null> {
  const env = getEnv();
  if (!env.SEGFY_ENABLED) {
    logger.info("[segfy] SEGFY_ENABLED=false; cotação não disparada", { conversaId: params.conversaId });
    return null;
  }
  const persist = new SupabasePersistence();

  const cliente = await persist.buscarClientePorId(params.clienteId);
  if (!cliente || !cliente.consentimento_lgpd) {
    await persist.registrarEtapa({
      conversaId: params.conversaId,
      etapa: "token",
      status: "erro",
      mensagem: cliente ? "Sem consentimento LGPD do cliente." : "Cliente não encontrado.",
    });
    return null;
  }

  const { entrada, faltando } = mapearParaCotacao(params.dados, cliente);
  if (!entrada) {
    await persist.registrarEtapa({
      conversaId: params.conversaId,
      etapa: "veiculo",
      status: "erro",
      mensagem: `Dados insuficientes para cotar: ${faltando.join(", ")}.`,
    });
    return null;
  }

  // Cria a cotação em 'processando' para as etapas/tela se ligarem.
  const { cotacaoId } = await persist.iniciarCotacao({
    conversaId: params.conversaId,
    clienteId: params.clienteId,
    ramo: "auto",
    dadosEntrada: { ...params.dados, placa: entrada.placa },
  });

  try {
    const { quotationId, resultados } = await cotarAuto(entrada, undefined, (e) => {
      void persist.registrarEtapa({
        cotacaoId,
        conversaId: params.conversaId,
        etapa: e.etapa,
        status: e.status,
        mensagem: e.mensagem,
      });
    });

    await persist.atualizarCotacao(cotacaoId, {
      status: "concluida",
      resultados,
      segfyCotacaoId: quotationId ?? undefined,
      validadeAte: new Date(Date.now() + VALIDADE_COTACAO_MS).toISOString(),
    });
    await persist.registrarEtapa({ cotacaoId, conversaId: params.conversaId, etapa: "salvar", status: "ok", mensagem: "Cotação salva." });
    await persist.registrarLog({
      operacao: "cotacao",
      via: "api",
      refId: quotationId ?? undefined,
      sucesso: resultados.some((r) => r.status === "cotado"),
      detalhe: { total: resultados.length, cotadas: resultados.filter((r) => r.status === "cotado").length },
    });

    const maisBarata = resultados.find((r) => r.status === "cotado") ?? null;
    const nome =
      asString(params.dados.nome) ?? asString(params.dados.segurado) ?? cliente.nome ?? "tudo certo";
    return { texto: formatarComparativoParaWhatsApp(resultados, nome), cotacaoId, maisBarata };
  } catch (e) {
    await persist.atualizarCotacao(cotacaoId, { status: "erro" });
    await persist.registrarEtapa({
      cotacaoId,
      conversaId: params.conversaId,
      etapa: "salvar",
      status: "erro",
      mensagem: e instanceof Error ? e.message.slice(0, 140) : String(e),
    });
    logger.error("[segfy] cotação falhou (não-fatal)", {
      conversaId: params.conversaId,
      erro: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
