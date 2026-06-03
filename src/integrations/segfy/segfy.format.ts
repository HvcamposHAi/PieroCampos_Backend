/**
 * Funções puras de formatação/normalização pt-BR.
 *
 * Sem dependências externas, sem I/O — totalmente determinísticas e cobertas
 * por testes unitários. Usadas pela formatação de comparativo (WhatsApp) e
 * pela normalização de valores extraídos via scraping ("R$ 1.234,56").
 */
import type { ResultadoCotacaoItem } from "./segfy.types";

/** Formata número como moeda BRL: 1234.5 -> "1.234,50". */
export function formatarMoedaBR(valor: number): string {
  return valor.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Converte um valor monetário em texto pt-BR para número.
 * Aceita "R$ 1.234,56", "1.234,56", "1234,56", "1234.56", "1234".
 * Retorna NaN para entradas sem dígitos (o chamador deve validar).
 */
export function normalizarValorMonetarioBR(texto: string): number {
  const limpo = texto.replace(/[^\d.,-]/g, "").trim();
  if (!/\d/.test(limpo)) return NaN;

  const temVirgula = limpo.includes(",");
  const temPonto = limpo.includes(".");

  let normalizado = limpo;
  if (temVirgula && temPonto) {
    // pt-BR: ponto = milhar, vírgula = decimal -> remove pontos, vírgula vira ponto
    normalizado = limpo.replace(/\./g, "").replace(",", ".");
  } else if (temVirgula) {
    normalizado = limpo.replace(",", ".");
  }
  // só ponto (ou nenhum): já está em formato parseável
  return Number(normalizado);
}

const MEDALHAS = ["🥇", "🥈", "🥉"] as const;

/**
 * Monta a mensagem de comparativo (top 3 por menor prêmio) para o WhatsApp.
 * Função pura: só formata a string; o ENVIO é responsabilidade do bot (fora deste módulo).
 */
export function formatarComparativoParaWhatsApp(
  resultados: ResultadoCotacaoItem[],
  nomeCliente: string,
): string {
  const top3 = resultados
    .filter((r) => r.status === "cotado")
    .sort((a, b) => a.premio_total - b.premio_total)
    .slice(0, 3);

  if (top3.length === 0) {
    return (
      `${nomeCliente}, infelizmente não conseguimos cotações disponíveis ` +
      `no momento. Nossa equipe vai entrar em contato em breve.`
    );
  }

  const linhas = top3.map((r, i) => {
    const icone = MEDALHAS[i] ?? "▫️";
    return [
      `${icone} *${r.seguradora}*`,
      `💰 R$ ${formatarMoedaBR(r.premio_total)}`,
      `📅 ${r.parcelas}x de R$ ${formatarMoedaBR(r.valor_parcela)}`,
      `🛡️ ${r.coberturas_resumo}`,
    ].join("\n");
  });

  return [
    `Olá ${nomeCliente}! Preparei as melhores opções para você 👇`,
    "",
    linhas.join("\n\n"),
    "",
    `Qual você prefere? É só me responder com o número (1, 2 ou 3) ou me contar ` +
      `se quer ver mais detalhes de alguma opção.`,
  ].join("\n");
}

/**
 * Mensagem de UMA opção (a escolhida pelo operador) para o WhatsApp. Função pura.
 * Usada pelo fluxo de escolha manual: o operador seleciona o resultado vencedor e
 * só ele é enviado ao cliente (em vez do comparativo top-3 automático).
 */
export function formatarOpcaoUnicaParaWhatsApp(
  resultado: ResultadoCotacaoItem,
  nomeCliente: string,
): string {
  return [
    `Olá ${nomeCliente}! Encontrei a melhor opção para o seu seguro 👇`,
    "",
    `🏢 *${resultado.seguradora}*`,
    `💰 R$ ${formatarMoedaBR(resultado.premio_total)}`,
    `📅 ${resultado.parcelas}x de R$ ${formatarMoedaBR(resultado.valor_parcela)}`,
    `🛡️ ${resultado.coberturas_resumo}`,
    "",
    `Posso seguir com essa opção? Me confirma que já dou andamento na sua proposta. 😊`,
  ].join("\n");
}
