/**
 * Orquestrador Segfy — ponto único de entrada.
 *
 * Decide API vs scraping: tenta a API; em falha de autenticação, captura o
 * token via scraper (Playwright) e tenta de novo. A persistência é injetada
 * (PersistencePort), então o módulo não conhece Supabase nem Twilio.
 */
import { logger } from "../../utils/logger";
import type { PersistencePort } from "./persistence.port";
import { criarOuAtualizarSegurado } from "./segfy.segurado";
import { dispararCotacaoAuto } from "./segfy.cotacao";
import { criarProposta } from "./segfy.proposta";
import { registrarApolice } from "./segfy.apolice";
import { lancarComissao } from "./segfy.comissao";
import { iniciarSessaoSegfy } from "./segfy.scraper";
import { invalidarToken } from "./segfy.auth";
import type { PayloadCotacaoAuto, ResultadoProcessamentoAuto } from "./segfy.types";

/** Dados coletados pelo bot (subconjunto de conversas.dados_coletados). */
export interface DadosFormularioPiero {
  nome: string;
  cpf?: string;
  email?: string;
  telefone?: string;
  estado_civil?: string;
  data_nascimento?: string;
  cep?: string;
  // Veículo (auto)
  fipe_codigo?: string;
  marca?: string;
  modelo?: string;
  ano_modelo?: number;
  ano_fabricacao?: number;
  uso_veiculo?: string;
  garagem?: string;
  alienado?: boolean;
  zero_km?: boolean;
  bonus_atual?: number;
  comissao_percentual?: number;
}

const VALIDADE_COTACAO_MS = 7 * 24 * 60 * 60 * 1000;

function mapUso(uso?: string): PayloadCotacaoAuto["veiculo"]["uso"] {
  if (uso === "aplicativo" || uso === "frota") return uso;
  return "particular"; // 'trabalho'/indefinido -> particular
}

function mapGaragem(g?: string): PayloadCotacaoAuto["veiculo"]["garagem"] {
  if (g === "descoberta" || g === "rua") return g;
  return "coberta";
}

export class SegfyClient {
  constructor(private readonly persistencia: PersistencePort) {}

  /** Tenta a operação; em falha de auth, captura token via scraper e repete 1x. */
  private async comFallbackDeToken<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (erro) {
      logger.warn("Segfy: falha na via API — tentando capturar token via scraper", {
        mensagem: erro instanceof Error ? erro.message : String(erro),
      });
      invalidarToken();
      await iniciarSessaoSegfy(); // captura o Bearer e injeta em segfy.auth
      return fn();
    }
  }

  async processarFormularioAuto(input: {
    conversaId: string | null;
    clienteId: string;
    dados: DadosFormularioPiero;
  }): Promise<ResultadoProcessamentoAuto> {
    const { conversaId, clienteId, dados } = input;

    const cliente = await this.persistencia.buscarClientePorId(clienteId);
    if (!cliente) throw new Error(`Cliente ${clienteId} não encontrado`);
    if (!cliente.consentimento_lgpd) {
      throw new Error(`Cliente ${clienteId} sem consentimento LGPD — não enviar PII ao Segfy`);
    }

    try {
      // 1. Garante o segurado no Segfy
      const { segfy_id } = await this.comFallbackDeToken(() =>
        criarOuAtualizarSegurado({
          nome: dados.nome,
          cpf: dados.cpf,
          email: dados.email,
          telefone: dados.telefone,
          estado_civil: dados.estado_civil,
          data_nascimento: dados.data_nascimento,
          endereco: dados.cep ? { cep: dados.cep } : undefined,
        }),
      );
      await this.persistencia.vincularSegfyIdAoCliente(clienteId, segfy_id);

      // 2. Dispara cotação
      const payload: PayloadCotacaoAuto = {
        segurado_id: segfy_id,
        veiculo: {
          fipe_codigo: dados.fipe_codigo ?? "",
          marca: dados.marca ?? "",
          modelo: dados.modelo ?? "",
          ano_modelo: dados.ano_modelo ?? 0,
          ano_fabricacao: dados.ano_fabricacao ?? 0,
          uso: mapUso(dados.uso_veiculo),
          garagem: mapGaragem(dados.garagem),
          cep_pernoite: dados.cep ?? "",
          alienado: dados.alienado ?? false,
          zero_km: dados.zero_km ?? false,
        },
        condutor_principal: {
          cpf: dados.cpf ?? "",
          data_nascimento: dados.data_nascimento ?? "",
          estado_civil: dados.estado_civil ?? "solteiro",
          bonus_atual: dados.bonus_atual ?? 0,
        },
        comissao_percentual: dados.comissao_percentual ?? 15,
      };

      const { cotacaoId, resultados } = await this.comFallbackDeToken(() =>
        dispararCotacaoAuto(payload),
      );

      // 3. Persiste (cotacao_id != segurado_id — corrige bug do MD §9)
      await this.persistencia.salvarCotacao({
        conversaId,
        clienteId,
        ramo: "auto",
        dadosEntrada: { ...dados },
        resultados,
        segfyCotacaoId: cotacaoId,
        validadeAte: new Date(Date.now() + VALIDADE_COTACAO_MS).toISOString(),
      });

      await this.persistencia.registrarLog({
        operacao: "cotacao",
        via: "api",
        refId: cotacaoId,
        sucesso: true,
        detalhe: { total_resultados: resultados.length },
      });

      logger.info("Segfy: cotação concluída", { segurado: segfy_id, total: resultados.length });
      return { segurado_id: segfy_id, cotacao_id: cotacaoId, resultados };
    } catch (erro) {
      await this.persistencia.registrarLog({
        operacao: "cotacao",
        via: "api",
        sucesso: false,
        detalhe: { erro: erro instanceof Error ? erro.message : String(erro) },
      });
      throw erro;
    }
  }

  async processarAceite(params: {
    cotacao_id_segfy: string;
    segurado_id: string;
    seguradora_escolhida: string;
    plano_escolhido: string;
    operador_nome: string;
  }) {
    return criarProposta(params);
  }

  async processarEmissao(params: {
    proposta_id: string;
    numero_apolice: string;
    inicio_vigencia: string;
    fim_vigencia: string;
    premio_total: number;
    percentual_comissao: number;
    valor_comissao: number;
    operador_nome: string;
  }) {
    const { apolice_id } = await registrarApolice({
      proposta_id: params.proposta_id,
      numero_apolice: params.numero_apolice,
      inicio_vigencia: params.inicio_vigencia,
      fim_vigencia: params.fim_vigencia,
      premio_total: params.premio_total,
    });

    await lancarComissao({
      apolice_id,
      percentual: params.percentual_comissao,
      valor: params.valor_comissao,
      operador_nome: params.operador_nome,
    });

    return { apolice_id };
  }
}
