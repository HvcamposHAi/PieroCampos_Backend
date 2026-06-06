/**
 * PORTA do transporte da API OFICIAL da Segfy. Interface PURA — sem I/O concreto,
 * sem Supabase, sem Express (mesmo isolamento de `persistence.port.ts`). Define o
 * que um futuro provider oficial chamaria; hoje só o `segfyOficialStub` a implementa.
 *
 * Quando a Segfy liberar a documentação, criar `segfy.oficial.http.ts`
 * (implementação real com axios) e um `quote/segfy-oficial.provider.ts` que
 * traduz QuoteContext → SegfyOficialCotacaoInput e devolve QuoteResult. Nada disso
 * exige mudar esta porta nem os tipos reusados de `segfy.types`.
 */
import type {
  SegfyOficialApolice,
  SegfyOficialAuthInput,
  SegfyOficialComissao,
  SegfyOficialCotacaoInput,
  SegfyOficialCotacaoResult,
  SegfyOficialToken,
} from "./segfy.oficial.types";

export interface SegfyOficialPort {
  /** Identificador legível p/ logs (ex.: "segfy-oficial"). */
  readonly nome: string;

  /** Autentica na API comercial e devolve um token de acesso. */
  autenticar(input: SegfyOficialAuthInput): Promise<SegfyOficialToken>;

  /** Dispara/consulta uma cotação Auto e devolve resultados já no formato do domínio. */
  cotarAuto(
    input: SegfyOficialCotacaoInput,
    token: SegfyOficialToken,
  ): Promise<SegfyOficialCotacaoResult>;

  /** Consulta uma apólice (roadmap). */
  obterApolice(apoliceId: string, token: SegfyOficialToken): Promise<SegfyOficialApolice>;

  /** Consulta comissões de uma apólice (roadmap). */
  listarComissoes(apoliceId: string, token: SegfyOficialToken): Promise<SegfyOficialComissao[]>;
}
