/**
 * Multicálculo Auto do Aggilizador (HTTP/JSON, sem RPA, sem 2FA).
 *
 * Sequência (derivada do HAR de 11/06/2026), emitindo as MESMAS etapas do Segfy
 * (token→segurado→veiculo→calculo→coleta) para reusar a UI de Etapas:
 *   1) token   : loginAggilizador → tokenPrincipal (PROD) + tokenMulticalculo (motor).
 *   2) segurado: /cadastros/cliente (pré-cadastro) + /calculo/cep → SeguradoPayload.
 *   3) veiculo : /calculo/buscaPlaca → AutomovelPayload (FIPE/ano/chassi).
 *   4) calculo : /cfg/seguradora/config (+ escondeLead) → calculos[]; POST
 *                /calculo/calcularV2 → { idIntegracao, versao }.
 *   5) coleta  : POLLING GET /calculo/cotacao/calculos/{id}/{versao} até todas
 *                retornarem (ou timeout) → ResultadoCotacaoItem[].
 *
 * ✅ A forma do polling com `retorno:true` está confirmada (ver resultado.ts).
 * ⚠️ VALIDAR-LIVE resta só: o formato do `idIntegracao` por seguradora no payload
 * de `calcularV2` e o domínio numérico de `estadoCivil`. Enquanto
 * `AGGILIZADOR_ENABLED=false`, este fluxo NÃO roda. Nunca logamos token/CPF/senha.
 */
import { logger } from "../../utils/logger";
import {
  AGGILIZADOR_MULTICALCULO_API,
  AGGILIZADOR_MULTICALCULO_BASE_URL,
  AGGILIZADOR_PROD_API,
  AGGILIZADOR_PROD_BASE_URL,
} from "./endpoints";
import { loginAggilizador, type CredenciaisAggilizador } from "./aggilizador.auth";
import { aggGet, aggPost } from "./aggilizador.http";
import { mapearResultadoAggilizador, todasRetornaram } from "./aggilizador.resultado";
import { erroCurtoAggilizador } from "./aggilizador.erros-curto";
import type { EntradaAggilizador } from "./aggilizador.mapper";
import type {
  AutomovelPayload,
  BuscaPlacaResponse,
  CadastroClienteResponse,
  CalcularV2Payload,
  CalcularV2Response,
  CalculoSeguradora,
  CepResponse,
  CoberturasPayload,
  ResultadoCotacaoItem,
  SeguradoPayload,
  SeguradoraConfigItem,
} from "./aggilizador.types";

/** Teto absoluto de coleta (algumas seguradoras chegam a ~31s; mostra parcial no fim). */
const TIMEOUT_POLLING_MS = 90_000;
/** Intervalo entre polls (~6s observado no HAR; ~6 polls até todas responderem). */
const INTERVALO_POLLING_MS = 6_000;

/**
 * Coberturas-padrão (valores observados na sessão real). Servem de base p/ todas
 * as seguradoras; a curadoria fina por cobertura fica para um incremento futuro.
 */
export const COBERTURAS_PADRAO: CoberturasPayload = {
  tipoCobertura: 2, // compreensiva
  tipoFranquia: 1, // reduzida
  isDanosMateriais: 250000,
  isDanosCorporais: 250000,
  isDanosMorais: 25000,
  isAppMorte: 10000,
  isBlindagemValor: 0,
  carroReserva: 2,
  carroReservaAr: true,
  despesasExtra: false,
  protecaoPneuRodas: false,
  reparoRapido: false,
  vidros: 2,
  assist24hs: 1,
};

export interface EtapaEventoAggilizador {
  etapa: "token" | "segurado" | "veiculo" | "calculo" | "coleta";
  status: "andamento" | "ok" | "erro";
  mensagem?: string;
}

export interface ResultadoCotacaoAggilizador {
  idIntegracao: string | null;
  versao: number;
  resultados: ResultadoCotacaoItem[];
}

/** Pausa cancelável simples (não bloqueia o event loop além do necessário). */
function dormir(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Dispara a cotação Auto no Aggilizador e coleta os resultados por polling.
 * `onEtapa` é a observabilidade (cada etapa vira linha na aba Etapas).
 */
export async function cotarAutoAggilizador(
  entrada: EntradaAggilizador,
  credenciais: CredenciaisAggilizador,
  onEtapa?: (e: EtapaEventoAggilizador) => void,
): Promise<ResultadoCotacaoAggilizador> {
  const emit = (e: EtapaEventoAggilizador): void => {
    try {
      onEtapa?.(e);
    } catch {
      /* observabilidade nunca quebra a cotação */
    }
  };
  async function comEtapa<T>(
    etapa: EtapaEventoAggilizador["etapa"],
    fn: () => Promise<T>,
    okMsg?: string,
  ): Promise<T> {
    emit({ etapa, status: "andamento" });
    try {
      const r = await fn();
      emit({ etapa, status: "ok", mensagem: okMsg });
      return r;
    } catch (e) {
      emit({ etapa, status: "erro", mensagem: erroCurtoAggilizador(e) });
      throw e;
    }
  }

  // 0) token — login (PROD + Multicálculo).
  const sessao = await comEtapa("token", () => loginAggilizador(credenciais), "autenticado no Aggilizador");
  // Só o Authorization por host; os demais headers (fiéis ao navegador) + TLS +
  // retry/diagnóstico vêm da camada `aggilizador.http`.
  const authProd = { Authorization: `Bearer ${sessao.tokenPrincipal}` };
  const authMc = { Authorization: `Bearer ${sessao.tokenMulticalculo}` };
  const getProd = <T>(path: string): Promise<T> => aggGet<T>(`${AGGILIZADOR_PROD_BASE_URL}${path}`, authProd);
  const getMc = <T>(path: string): Promise<T> => aggGet<T>(`${AGGILIZADOR_MULTICALCULO_BASE_URL}${path}`, authMc);

  // 1) segurado — pré-cadastro (CPF) + endereço (CEP).
  const segurado = await comEtapa(
    "segurado",
    async () => {
      const [cadastro, enderecos] = await Promise.all([
        getProd<CadastroClienteResponse | null>(AGGILIZADOR_PROD_API.cadastroCliente(entrada.cpf)).catch(() => null),
        getMc<CepResponse[]>(AGGILIZADOR_MULTICALCULO_API.cep(entrada.cep)).catch(() => [] as CepResponse[]),
      ]);
      const end = Array.isArray(enderecos) ? enderecos[0] : undefined;
      const dataNasc = entrada.dataNascimento ?? cadastro?.dataNas ?? null;
      const sexo = entrada.sexo ?? cadastro?.sexo ?? null;
      const nome = entrada.nome ?? cadastro?.nome ?? null;
      if (!nome) throw new Error("Nome do segurado não informado (coletar com a Bia ou cadastrar).");
      if (!dataNasc) throw new Error("Data de nascimento do segurado não localizada.");
      if (!sexo) throw new Error("Sexo do segurado não informado.");
      const payload: SeguradoPayload = {
        nome,
        tipoPessoa: "F",
        cpfCnpj: entrada.cpf,
        estadoCivil: entrada.estadoCivilCodigo,
        dataNasc: `${dataNasc}T00:00:00.000Z`,
        sexo,
        fone1: entrada.telefone ?? cadastro?.fone?.replace(/\D/g, "") ?? "",
        cep: entrada.cep,
        email: entrada.email ?? "",
        uf: end?.uf ?? "",
        cidade: end?.cidade ?? "",
        bairro: end?.bairro ?? "",
        logradouro: end?.logradouro ?? "",
        isPCD: false,
      };
      return payload;
    },
    "segurado preparado",
  );

  // 2) veiculo — placa → FIPE/ano/chassi.
  const automovel = await comEtapa(
    "veiculo",
    async () => {
      const v = await getMc<BuscaPlacaResponse | null>(AGGILIZADOR_MULTICALCULO_API.buscaPlaca(entrada.placa));
      if (!v || !v.fipe) throw new Error("Placa não decodificada (FIPE não encontrada).");
      const payload: AutomovelPayload = {
        fipe: v.fipe,
        anoMod: v.anoMod,
        anoFab: v.anoFab,
        placa: entrada.placa,
        tipoVeic: v.tipoVeic || "v",
        chassi: v.chassi,
        modelo: v.modelo,
        codFabr: v.codFabr,
        valorDeNovo: entrada.zeroKm ? 1 : 0,
      };
      return payload;
    },
    "veículo identificado (FIPE)",
  );

  // 3) calculo — monta calculos[] das seguradoras configuradas e dispara.
  const { idIntegracao, versao } = await comEtapa(
    "calculo",
    async () => {
      const [configs, escondidas] = await Promise.all([
        getProd<SeguradoraConfigItem[]>(AGGILIZADOR_PROD_API.seguradoraConfig),
        getProd<number[]>(AGGILIZADOR_PROD_API.escondeLead).catch(() => [] as number[]),
      ]);
      const ocultas = new Set(Array.isArray(escondidas) ? escondidas : []);
      const calculos: CalculoSeguradora[] = (Array.isArray(configs) ? configs : [])
        .filter((s) => s.ativo && s.credenciaisValidas && !ocultas.has(s.seguradora))
        .map((s) => ({
          ...COBERTURAS_PADRAO,
          ativo: true,
          nome: s.nomeSeguradora,
          nomeSeguradora: s.nomeSeguradora,
          login: s.login,
          senha: s.senha,
          seguradora: s.seguradora,
          // ⚠️ VALIDAR-LIVE: formato observado do idIntegracao por seguradora.
          idIntegracao: `_seguradora_${s.seguradora}_corretora_${sessao.corretoraId}_`,
          percComissao: s.percComissao ?? 0,
          percDesconto: s.percDesconto ?? 0,
          configsGlobais: true,
          credenciaisValidas: true,
          valorDeNovo: automovel.valorDeNovo,
        }));
      if (calculos.length === 0) {
        throw new Error("Nenhuma seguradora ativa/válida configurada no Aggilizador para esta corretora.");
      }
      const payload: CalcularV2Payload = {
        cotacao: { segurado, calculos, automovel, coberturas: COBERTURAS_PADRAO },
      };
      const resp = await aggPost<CalcularV2Response>(
        `${AGGILIZADOR_PROD_BASE_URL}${AGGILIZADOR_PROD_API.calcularV2}`,
        payload,
        authProd,
        40_000,
      );
      if (!resp.data?.idIntegracao) throw new Error("calcularV2 não retornou idIntegracao.");
      logger.info("[aggilizador] cotação disparada", {
        idIntegracao: resp.data.idIntegracao,
        versao: resp.data.versao,
        seguradoras: calculos.length,
      });
      return { idIntegracao: resp.data.idIntegracao, versao: resp.data.versao ?? 1 };
    },
    "cálculo disparado",
  );

  // 4) coleta — polling até todas retornarem ou timeout.
  emit({ etapa: "coleta", status: "andamento" });
  const itens = new Map<string, ResultadoCotacaoItem>();
  const inicio = Date.now();
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const lista = await getMc<unknown[]>(
        AGGILIZADOR_MULTICALCULO_API.pollingResultados(idIntegracao, versao),
      ).catch(() => [] as unknown[]);
      const arr = Array.isArray(lista) ? lista : [];
      for (const raw of arr) {
        try {
          const item = mapearResultadoAggilizador(raw);
          // Só sobrescreve com um estado "mais final" (cotado/recusado > processando).
          const atual = itens.get(item.seguradora);
          if (!atual || (atual.status === "processando" && item.status !== "processando")) {
            itens.set(item.seguradora, item);
          }
        } catch (e) {
          logger.warn("[aggilizador] item de polling não parseável", {
            erro: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (arr.length > 0 && todasRetornaram(arr)) break;
      if (Date.now() - inicio >= TIMEOUT_POLLING_MS) break;
      await dormir(INTERVALO_POLLING_MS);
    }
  } catch (e) {
    emit({ etapa: "coleta", status: "erro", mensagem: erroCurtoAggilizador(e) });
    throw e;
  }
  const respondidas = [...itens.values()].filter((r) => r.status !== "processando").length;
  emit({ etapa: "coleta", status: "ok", mensagem: `${respondidas} de ${itens.size} seguradoras responderam` });

  // Cotadas primeiro, por menor prêmio.
  const resultados = [...itens.values()]
    .filter((r) => r.status !== "processando")
    .sort((a, b) => {
      if (a.status === "cotado" && b.status !== "cotado") return -1;
      if (b.status === "cotado" && a.status !== "cotado") return 1;
      return a.premio_total - b.premio_total;
    });
  return { idIntegracao, versao, resultados };
}
