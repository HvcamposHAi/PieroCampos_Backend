/**
 * CRITÉRIO DE SUCESSO por objetivo — a condição de PARADA do agente construtor.
 *
 * PURO: recebe o objetivo + o resultado de uma execução de teste e diz se o
 * objetivo foi atingido (e por quê). É o coração do "executar até concluir":
 * o loop só congela o adapter quando `avaliarCriterio` retorna `atingido=true`.
 */
import type { CriterioSucesso, Objetivo } from "../descoberta.types";
import type { ResultadoCotacaoItem } from "../../segfy/segfy.types";

/** Resultado normalizado de uma tentativa de execução (qualquer objetivo). */
export interface ResultadoObjetivo {
  /** cotação. */
  resultados?: ResultadoCotacaoItem[];
  /** apólice. */
  numeroApolice?: string | null;
  pdfBytes?: number; // tamanho do PDF (não os bytes — sem PII)
  /** consulta / campos extraídos. */
  campos?: Record<string, unknown>;
  /** validação de estrutura. */
  veredito?: "suporta" | "parcial" | "nao_suporta";
}

export interface AvaliacaoCriterio {
  atingido: boolean;
  motivo: string;
}

/** Critério default para um objetivo (quando não há override no adapter). */
export function criterioPadrao(objetivo: Objetivo): CriterioSucesso {
  switch (objetivo) {
    case "apolice":
      return { objetivo, exige: ["numeroApolice", "pdf"] };
    case "cotacao":
      return { objetivo, minCotados: 1 };
    case "consulta":
      return { objetivo, exige: [] };
    case "validar_estrutura":
      return { objetivo };
  }
}

export function avaliarCriterio(criterio: CriterioSucesso, r: ResultadoObjetivo): AvaliacaoCriterio {
  switch (criterio.objetivo) {
    case "apolice": {
      const temNumero = typeof r.numeroApolice === "string" && r.numeroApolice.trim().length > 0;
      const temPdf = (r.pdfBytes ?? 0) > 0;
      if (temNumero && temPdf) return { atingido: true, motivo: "apólice emitida e PDF extraído" };
      const faltas: string[] = [];
      if (!temNumero) faltas.push("numeroApolice");
      if (!temPdf) faltas.push("pdf");
      return { atingido: false, motivo: `faltou: ${faltas.join(", ")}` };
    }
    case "cotacao": {
      const cotados = (r.resultados ?? []).filter((x) => x.status === "cotado" && x.premio_total > 0).length;
      const min = criterio.minCotados ?? 1;
      return cotados >= min
        ? { atingido: true, motivo: `${cotados} cotação(ões) válida(s)` }
        : { atingido: false, motivo: `${cotados}/${min} cotações válidas` };
    }
    case "consulta": {
      const exige = criterio.exige ?? [];
      const faltam = exige.filter((k) => r.campos?.[k] == null || r.campos[k] === "");
      return faltam.length === 0
        ? { atingido: true, motivo: "campos-alvo presentes" }
        : { atingido: false, motivo: `faltou: ${faltam.join(", ")}` };
    }
    case "validar_estrutura": {
      return r.veredito === "suporta"
        ? { atingido: true, motivo: "estrutura suporta o objetivo" }
        : { atingido: false, motivo: `estrutura: ${r.veredito ?? "desconhecida"}` };
    }
  }
}
