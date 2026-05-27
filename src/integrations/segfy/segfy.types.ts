/**
 * Tipos e schemas Zod dos payloads/respostas Segfy.
 *
 * ⚠️ GATE DE MAPEAMENTO: os nomes/forma das respostas da API (auth, cotação)
 * ainda NÃO foram confirmados — a "API interna" do MD não se reproduz
 * (api.segfy.com é .NET legado; api-v2 raiz dá 404). Estes schemas refletem
 * a EXPECTATIVA do MD e existem para parse defensivo; ajuste-os com a saída
 * de `npm run segfy:mapear` antes de habilitar a integração real.
 *
 * Todo dado vindo do Segfy é validado por estes schemas (nunca `any`).
 */
import { z } from "zod";

// ----------------------------------------------------------------------------
// Entrada do nosso domínio (formulário Piero -> Segfy)
// ----------------------------------------------------------------------------

export const EnderecoSchema = z.object({
  cep: z.string(),
  logradouro: z.string().optional(),
  numero: z.string().optional(),
  bairro: z.string().optional(),
  cidade: z.string().optional(),
  uf: z.string().optional(),
});
export type Endereco = z.infer<typeof EnderecoSchema>;

export const SeguradoSegfySchema = z.object({
  nome: z.string().min(1),
  cpf: z.string().optional(),
  rg: z.string().optional(),
  email: z.string().email().optional(),
  telefone: z.string().optional(),
  data_nascimento: z.string().optional(), // YYYY-MM-DD
  estado_civil: z.string().optional(),
  endereco: EnderecoSchema.optional(),
});
export type SeguradoSegfy = z.infer<typeof SeguradoSegfySchema>;

export const PayloadCotacaoAutoSchema = z.object({
  segurado_id: z.string().min(1),
  veiculo: z.object({
    placa: z.string().optional(),
    fipe_codigo: z.string(),
    marca: z.string(),
    modelo: z.string(),
    ano_modelo: z.number().int(),
    ano_fabricacao: z.number().int(),
    uso: z.enum(["particular", "aplicativo", "frota"]),
    garagem: z.enum(["coberta", "descoberta", "rua"]),
    cep_pernoite: z.string(),
    alienado: z.boolean(),
    zero_km: z.boolean(),
  }),
  condutor_principal: z.object({
    cpf: z.string(),
    data_nascimento: z.string(),
    estado_civil: z.string(),
    sexo: z.string().optional(),
    bonus_atual: z.number().int().min(0).max(10),
  }),
  coberturas: z
    .object({
      casco: z.boolean(),
      rcf_danos_materiais: z.number().optional(),
      rcf_danos_corporais: z.number().optional(),
      app: z.boolean().optional(),
      vidros: z.boolean().optional(),
      carro_reserva_dias: z.number().optional(),
    })
    .optional(),
  comissao_percentual: z.number().optional(),
});
export type PayloadCotacaoAuto = z.infer<typeof PayloadCotacaoAutoSchema>;

// ----------------------------------------------------------------------------
// Respostas Segfy (PENDENTE confirmação via mapeamento)
// ----------------------------------------------------------------------------

/** Resposta esperada do login. */
export const AuthResponseSchema = z.object({
  token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().int().positive().optional(), // segundos
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

/** Um resultado individual de cotação (uma seguradora). */
export const ResultadoCotacaoItemSchema = z.object({
  seguradora: z.string(),
  premio_total: z.number().nonnegative(),
  parcelas: z.number().int().positive().default(1),
  valor_parcela: z.number().nonnegative().default(0),
  coberturas_resumo: z.string().default(""),
  // 'cotado' = oferta válida; outros valores = recusado/indisponível.
  status: z.string().default("cotado"),
});
export type ResultadoCotacaoItem = z.infer<typeof ResultadoCotacaoItemSchema>;

export const STATUS_COTACAO_SEGFY = ["pendente", "processando", "concluida", "erro"] as const;
export type StatusCotacaoSegfy = (typeof STATUS_COTACAO_SEGFY)[number];

/** Envelope do polling de cotação. */
export const CotacaoStatusResponseSchema = z.object({
  cotacao_id: z.string(),
  status: z.enum(STATUS_COTACAO_SEGFY),
  resultados: z.array(ResultadoCotacaoItemSchema).default([]),
});
export type CotacaoStatusResponse = z.infer<typeof CotacaoStatusResponseSchema>;

/** Resposta do disparo inicial da cotação. */
export const CotacaoDisparoResponseSchema = z.object({
  cotacao_id: z.string().min(1),
});
export type CotacaoDisparoResponse = z.infer<typeof CotacaoDisparoResponseSchema>;

export const SeguradoResponseSchema = z.object({
  id: z.string().min(1),
});
export type SeguradoResponse = z.infer<typeof SeguradoResponseSchema>;

// ----------------------------------------------------------------------------
// Resultado consolidado do orquestrador
// ----------------------------------------------------------------------------

/** Saída de processarFormularioAuto — `segurado_id` e `cotacao_id` SEPARADOS
 *  (corrige o bug do MD §9 que gravava segurado_id em segfy_cotacao_id). */
export interface ResultadoProcessamentoAuto {
  segurado_id: string;
  cotacao_id: string;
  resultados: ResultadoCotacaoItem[];
}
