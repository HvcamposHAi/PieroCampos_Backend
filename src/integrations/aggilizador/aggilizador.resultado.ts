/**
 * Parsing dos RESULTADOS do polling do Aggilizador → `ResultadoCotacaoItem`
 * (contrato único de comparativo, idêntico ao Segfy). PURO e testável.
 *
 * ✅ FORMA CONFIRMADA no HAR de cotação CONCLUÍDA (11/06/2026): o polling
 * (GET /calculo/cotacao/calculos/{id}/{versao}) devolve um ARRAY, uma entrada
 * por seguradora. Cada entrada com `retorno:true` traz:
 *   - `premio` (anual, no raiz) = prêmio do plano com `principal:true`;
 *   - `premioMensal` (≈ premio/12, indicativo);
 *   - `resultados[]`: planos/pacotes, cada um com `coberturas{}` e `parcelamentos[]`.
 * `retorno:true` + `premio:0` + `resultados:[]` = seguradora respondeu mas NÃO fez
 * oferta para o perfil (recusa, não erro). `retornoErro:true` = falhou.
 *
 * Mapeamos o plano `principal` (ou o 1º) para o item de comparativo. Os campos
 * extras úteis para PROPOSTA futura (`nroCalculo`, `id`/calcId, `pdfFileNameAgger`)
 * NÃO cabem no contrato atual de `ResultadoCotacaoItem` — ficam para o incremento
 * de emissão; aqui priorizamos preço + parcelamento + resumo de coberturas.
 */
import { z } from "zod";
import type { ResultadoCotacaoItem } from "../segfy/segfy.types";

const ParcelamentoSchema = z
  .object({
    parcelas: z.number().optional(),
    premioPrimeiraParc: z.number().nullable().optional(),
    premioDemaisParc: z.number().nullable().optional(),
    tipoPag: z.number().optional(), // 1=cartão, 2=débito, 3=boleto à vista
  })
  .passthrough();

const CoberturasResultadoSchema = z
  .object({
    tipo: z.string().nullable().optional(),
    tipoPadronizado: z.string().nullable().optional(),
    franquiaPadronizado: z.string().nullable().optional(),
    assist24hs: z.string().nullable().optional(),
    carroReserva: z.string().nullable().optional(),
    vidros: z.string().nullable().optional(),
  })
  .passthrough();

const PlanoSchema = z
  .object({
    principal: z.boolean().optional(),
    selected: z.boolean().optional(),
    identificacao: z.string().nullable().optional(),
    premio: z.number().nullable().optional(),
    premioMensal: z.number().nullable().optional(),
    franquia: z.number().nullable().optional(),
    coberturas: CoberturasResultadoSchema.optional(),
    parcelamentos: z.array(ParcelamentoSchema).nullable().optional(),
  })
  .passthrough();

/** Schema defensivo do item de polling (tolera campos extras via passthrough). */
export const PollingItemSchema = z
  .object({
    seguradoraTxt: z.string().optional(),
    seguradora: z.number().optional(),
    retorno: z.boolean().optional(),
    retornoErro: z.boolean().optional(),
    premio: z.number().nullable().optional(),
    premioMensal: z.number().nullable().optional(),
    tempoResposta: z.number().nullable().optional(),
    mensagem: z.string().nullable().optional(),
    resultados: z.array(PlanoSchema).nullable().optional(),
  })
  .passthrough();

/** true se TODAS as seguradoras já retornaram (oferta, recusa ou erro). */
export function todasRetornaram(itens: unknown[]): boolean {
  if (itens.length === 0) return false;
  return itens.every((raw) => {
    const r = PollingItemSchema.safeParse(raw);
    if (!r.success) return false;
    return r.data.retorno === true || r.data.retornoErro === true;
  });
}

type Plano = z.infer<typeof PlanoSchema>;

/**
 * (parcelas, valor_parcela) do plano. Prioriza CARTÃO (tipoPag=1) com o maior
 * número de parcelas; senão qualquer forma; senão usa `premioMensal` (12x) ou o
 * prêmio à vista. `premioPrimeiraParc` é o valor da parcela.
 */
function melhorParcelamento(
  plano: Plano | undefined,
  premio: number,
): { parcelas: number; valor_parcela: number } {
  const parcs = plano?.parcelamentos ?? undefined;
  if (Array.isArray(parcs) && parcs.length > 0) {
    const cartao = parcs.filter((p) => p.tipoPag === 1 && (p.parcelas ?? 0) > 0);
    const pool = cartao.length ? cartao : parcs.filter((p) => (p.parcelas ?? 0) > 0);
    if (pool.length) {
      const melhor = pool.reduce((a, b) => ((b.parcelas ?? 0) > (a.parcelas ?? 0) ? b : a));
      const valor = melhor.premioPrimeiraParc ?? melhor.premioDemaisParc ?? 0;
      return { parcelas: melhor.parcelas ?? 1, valor_parcela: valor ?? 0 };
    }
  }
  const mensal = plano?.premioMensal;
  if (typeof mensal === "number" && mensal > 0) return { parcelas: 12, valor_parcela: mensal };
  return { parcelas: 1, valor_parcela: premio };
}

/** Resumo curto de coberturas para o WhatsApp (tipo · franquia · assist · reserva). */
function resumoCoberturas(plano: Plano | undefined): string {
  const c = plano?.coberturas;
  if (!c) return "";
  const partes = [
    c.tipoPadronizado ?? c.tipo,
    c.franquiaPadronizado ? `Franquia ${c.franquiaPadronizado}` : undefined,
    c.assist24hs && c.assist24hs !== "Não" ? `Assist. ${c.assist24hs}` : undefined,
    c.carroReserva && c.carroReserva !== "Não" ? `Carro reserva ${c.carroReserva}` : undefined,
  ].filter(Boolean) as string[];
  return partes.join(" · ").slice(0, 160);
}

/** Limpa HTML/entidades de uma mensagem e corta p/ exibição curta. */
function limparMensagem(msg?: string | null): string | undefined {
  if (!msg) return undefined;
  const t = msg
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t ? t.slice(0, 180) : undefined;
}

/**
 * Converte um item de polling no item de comparativo do bot. PURO.
 * `cotado` = retornou com prêmio > 0; `recusado` = retornou sem oferta ou com
 * erro; `processando` = ainda não retornou (filtrado antes da exibição).
 */
export function mapearResultadoAggilizador(raw: unknown): ResultadoCotacaoItem {
  const d = PollingItemSchema.parse(raw);
  const premio = typeof d.premio === "number" && Number.isFinite(d.premio) ? d.premio : 0;
  const erro = d.retornoErro === true;
  const respondeu = d.retorno === true;
  const cotado = respondeu && !erro && premio > 0;

  // Plano destaque: `principal:true` (o que o Aggilizador exibe), senão o 1º.
  const plano = d.resultados?.find((r) => r.principal) ?? d.resultados?.[0];
  const { parcelas, valor_parcela } = melhorParcelamento(plano, premio);

  return {
    seguradora: d.seguradoraTxt ?? "Seguradora",
    premio_total: premio,
    parcelas,
    valor_parcela,
    coberturas_resumo: cotado ? resumoCoberturas(plano) : "",
    status: cotado ? "cotado" : erro ? "recusado" : respondeu ? "recusado" : "processando",
    motivo: cotado ? undefined : limparMensagem(d.mensagem) ?? (respondeu && !erro ? "Sem oferta para o perfil" : undefined),
  };
}
