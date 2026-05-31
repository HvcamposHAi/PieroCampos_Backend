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
import type { PersistencePort } from "../integrations/segfy/persistence.port";
import { SupabasePersistence } from "../integrations/persistence/supabase-persistence";
import { obterCredenciaisSegfy } from "./segfy-credenciais.service";
import { cpfValido } from "../lib/cpf";
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
  // CPF: fonte única. Prioriza o COLETADO/editado (dados_coletados) e cai no
  // cadastro. Valida o dígito: CPF preenchido porém inválido entra na crítica.
  const cpfBruto = asString(dados.cpf) ?? asString(dados.cpf_cnpj) ?? asString(cliente.cpf);
  const cpf = cpfBruto?.replace(/\D/g, "");
  const placa = extrairPlaca(dados);
  const cep = asString(dados.cep) ?? asString(dados.endereco);
  if (!cpf) faltando.push("cpf");
  else if (!cpfValido(cpf)) faltando.push("cpf (inválido)");
  if (!placa) faltando.push("placa do veículo");
  if (!cep) faltando.push("cep");
  if (faltando.length > 0 || !cpf || !placa || !cep) return { entrada: null, faltando };

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
 * Dispara a cotação no Segfy com OBSERVABILIDADE PRIMEIRO: cria a cotação
 * (`processando`) e a 1ª etapa LOGO no início, para que a tela (aba Etapas +
 * página Cotações) SEMPRE mostre a tentativa — inclusive quando a integração
 * está desabilitada, falta consentimento/dados, ou o Segfy falha (cada caso
 * vira uma etapa de ERRO legível). Devolve o comparativo (menor preço) ou null.
 * `persistInjetado` permite testar sem Supabase.
 */
export async function dispararCotacaoSegfy(
  params: { conversaId: string; clienteId: string; dados: Record<string, unknown> },
  persistInjetado?: PersistencePort,
): Promise<ResultadoDisparo | null> {
  const env = getEnv();
  const persist: PersistencePort = persistInjetado ?? new SupabasePersistence();

  // 1) Cria a cotação SEMPRE (observabilidade imediata via realtime).
  const { cotacaoId } = await persist.iniciarCotacao({
    conversaId: params.conversaId,
    clienteId: params.clienteId,
    ramo: "auto",
    dadosEntrada: params.dados,
  });
  // NÃO pré-marcamos a etapa "token" como andamento aqui: as validações abaixo
  // (flag/cliente/LGPD/dados/credenciais) acontecem ANTES da autenticação. Se
  // alguma falhar, a etapa real de erro é registrada por `falhar(...)` e o passo
  // "token" continua PENDENTE (sem spinner eterno). Quando a corrida real começa,
  // `cotarAuto` emite token→andamento→ok via onEtapa. (Bug: spinner travado na
  // "Autenticação no Segfy" mascarando o erro real de baixo.)

  // Helper: marca a etapa/cotação como ERRO e encerra (visível na tela).
  const falhar = async (etapa: "token" | "segurado" | "veiculo" | "calculo" | "coleta" | "salvar", msg: string): Promise<null> => {
    await persist.registrarEtapa({ cotacaoId, conversaId: params.conversaId, etapa, status: "erro", mensagem: msg });
    await persist.atualizarCotacao(cotacaoId, { status: "erro" });
    logger.warn("[segfy] cotação não concluída", { conversaId: params.conversaId, etapa, msg });
    return null;
  };

  if (!env.SEGFY_ENABLED) {
    return falhar("token", "Integração Segfy desabilitada (SEGFY_ENABLED=false). Habilite para cotar de verdade.");
  }
  const cliente = await persist.buscarClientePorId(params.clienteId);
  if (!cliente) return falhar("token", "Cliente não encontrado ou excluído.");
  if (!cliente.consentimento_lgpd) return falhar("token", "Sem consentimento LGPD do cliente.");

  const { entrada, faltando } = mapearParaCotacao(params.dados, cliente);
  if (!entrada) {
    // CPF falta → falha no passo do segurado; demais (placa/cep) → no veículo.
    const etapaFalha = faltando.some((f) => f.startsWith("cpf")) ? "segurado" : "veiculo";
    return falhar(etapaFalha, `Faltam dados para cotar: ${faltando.join(", ")}. Complemente em 'Dados coletados' ou peça à Bia.`);
  }

  // Credenciais do portal: banco (tela Admin) com fallback .env. Sem nenhuma → não cota.
  const credenciais = await obterCredenciaisSegfy();
  if (!credenciais) {
    return falhar("token", "Credenciais do Segfy não configuradas (Admin > Segfy ou .env).");
  }

  try {
    const { quotationId, resultados } = await cotarAuto(
      entrada,
      undefined,
      (e) => {
        void persist.registrarEtapa({
          cotacaoId,
          conversaId: params.conversaId,
          etapa: e.etapa,
          status: e.status,
          mensagem: e.mensagem,
        });
      },
      { email: credenciais.email, password: credenciais.password },
    );

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
    // A etapa REAL que falhou (calculo/segurado/...) já foi registrada como erro
    // pelo `onEtapa` do cotarAuto, com o motivo real. NÃO registramos um segundo
    // erro em "salvar" (isso criava uma 2ª linha vermelha enganosa); só marcamos
    // a cotação como erro — "Salvar cotação" permanece pendente.
    await persist.atualizarCotacao(cotacaoId, { status: "erro" });
    logger.error("[segfy] cotação falhou (não-fatal)", {
      conversaId: params.conversaId,
      erro: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
