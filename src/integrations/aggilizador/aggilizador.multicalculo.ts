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
  RAMO_AUTO_SUSEP,
} from "./endpoints";
import { loginAggilizador, type CredenciaisAggilizador } from "./aggilizador.auth";
import { aggGet, aggPost, authHeader } from "./aggilizador.http";
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
  CarroPayload,
  CepResponse,
  CoberturasPayload,
  CondutorPayload,
  FipeModeloItem,
  ResultadoCotacaoItem,
  SeguradoPayload,
  SeguradoraConfigItem,
  SeguradoraStatusItem,
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

/**
 * Valores NEUTROS do "questionário" do veículo que o motor do Aggilizador EXIGE
 * mas a Bia NÃO coleta (decisão de produto: o Aggilizador não roda questionário).
 * Antes iam como `null`/`"0"` → toda seguradora recusava. Agora saem destes
 * defaults e podem ser SOBREPOSTOS pelo operador na cotação manual (overrides em
 * `EntradaAggilizador`).
 *
 * ✅ Valores CONFIRMADOS no HAR de cotação CONCLUÍDA (14/06): `combustivel:11`
 * (flex; NÃO vem da FIPE — é seleção do usuário), `pctAjuste:100` (percentual FIPE),
 * `garagemResidencia:"1"` + `garagemTrabalho/Estudo:"0"`, `kmAnual` anual (HAR: 6000).
 * 🚨 VALIDAR-LIVE só os DEMAIS códigos de combustível (apenas flex=11 veio no HAR).
 */
export const DEFAULTS_AGGILIZADOR = {
  /** Código de combustível — 11 = flex (confirmado no HAR; é o mais comum). */
  combustivel: 11,
  /** Quilometragem ANUAL padrão (HAR confirmou unidade anual). */
  kmAnual: 12_000,
  /** Garagem na RESIDÊNCIA: "1" = possui (HAR). Trabalho/estudo vão "0". */
  garagem: "1",
  /** Percentual da tabela FIPE a segurar: 100 = 100% (HAR: campo `pctAjuste`). */
  pctAjuste: 100,
} as const;

export interface EtapaEventoAggilizador {
  etapa: "token" | "segurado" | "veiculo" | "calculo" | "coleta";
  status: "andamento" | "ok" | "erro";
  mensagem?: string;
}

/**
 * Seleciona as seguradoras elegíveis para o cálculo de AUTO e monta `calculos[]`.
 * Função PURA (sem rede) → testável isoladamente.
 *
 * Regras (confirmadas no HAR 12/06):
 *  - `ativo`/`credenciaisValidas` podem vir no TOPO ou em `configsSeg` (lê ambos).
 *  - opera AUTO = `seguradoraStatus.autoStatus===1` cruzando `seguradora`↔`id`.
 *    Se o status não veio (lista vazia), NÃO filtra por ramo (fallback seguro).
 *  - respeita `escondeLead` (ocultas).
 *  - usa o `idIntegracao` PRONTO da config; só remonta se faltar.
 *
 * Retorna os `calculos` e, se vazio, um `motivoZero` específico p/ a tela.
 */
export function selecionarCalculosAuto(
  configs: SeguradoraConfigItem[] | unknown,
  escondidas: number[] | unknown,
  statusSeg: SeguradoraStatusItem[] | unknown,
  corretoraId: string,
  valorDeNovo: number,
  /** Comissão (%) efetiva: cotação > default da corretora. Sobrepõe a da seguradora. */
  comissaoOverride?: number | null,
): { calculos: CalculoSeguradora[]; motivoZero: string | null } {
  const lista = Array.isArray(configs) ? (configs as SeguradoraConfigItem[]) : [];
  const ocultas = new Set(Array.isArray(escondidas) ? (escondidas as number[]) : []);

  const ativa = (s: SeguradoraConfigItem): boolean => (s.ativo ?? s.configsSeg?.ativo ?? false) === true;
  const credOk = (s: SeguradoraConfigItem): boolean =>
    (s.credenciaisValidas ?? s.configsSeg?.credenciaisValidas ?? false) === true;

  const autoAtivas = new Set(
    (Array.isArray(statusSeg) ? (statusSeg as SeguradoraStatusItem[]) : [])
      .filter((st) => st?.autoStatus === 1)
      .map((st) => st.id),
  );
  // Se o status não veio, libera todas (fallback) em vez de zerar a cotação.
  const operaAuto = (s: SeguradoraConfigItem): boolean => autoAtivas.size === 0 || autoAtivas.has(s.seguradora);

  const elegiveis = lista.filter((s) => ativa(s) && credOk(s) && operaAuto(s) && !ocultas.has(s.seguradora));
  const calculos: CalculoSeguradora[] = elegiveis.map((s) => {
    const id = s.idIntegracao ?? `_seguradora_${s.seguradora}_corretora_${corretoraId}_`;
    return {
      // Campos ESPECÍFICOS da seguradora (portoSusep, libertyFiliais, bradesco
      // Sucursal, mapfreCodVc, …) — o motor exige cada um; vêm do configsSeg do HAR.
      ...(s.configsSeg ?? {}),
      ...COBERTURAS_PADRAO,
      ativo: true,
      nome: s.nomeSeguradora,
      nomeSeguradora: s.nomeSeguradora,
      login: s.login,
      senha: s.senha,
      seguradora: s.seguradora,
      idIntegracao: id,
      idIntegracaoCfg: id,
      idIntegracaoCfgSeg: id,
      percComissao: comissaoOverride ?? s.percComissao ?? 0,
      percDesconto: s.percDesconto ?? 0,
      configsGlobais: true,
      credenciaisValidas: true,
      valorDeNovo,
      parcelasBaixar: false,
      aplicacaoId: 3,
      cargaIniciada: false,
    };
  });

  let motivoZero: string | null = null;
  if (calculos.length === 0) {
    const nAtivasCred = lista.filter((s) => ativa(s) && credOk(s)).length;
    if (lista.length === 0) motivoZero = "Nenhuma seguradora configurada no Aggilizador para esta corretora.";
    else if (nAtivasCred === 0)
      motivoZero =
        "Nenhuma seguradora com credenciais válidas no Aggilizador — revise as credenciais das seguradoras.";
    else
      motivoZero =
        "Nenhuma seguradora ativa e válida está habilitada para AUTO no momento (verifique o status das seguradoras).";
  }
  return { calculos, motivoZero };
}

/**
 * Valida e normaliza ano de fabricação/modelo (vindos do `buscaPlaca`). O motor do
 * Aggilizador EXIGE anos válidos e diferença fab↔modelo ≤ 1 ano — `0`/vazio ou uma
 * diferença maior fazem TODA seguradora recusar ("Ano de fabricação inválido" +
 * "A diferença de anos entre Fabricação e Modelo deve ser de até um ano"). PURA
 * (recebe o ano-base p/ ser testável). Lança erro claro quando indecifrável.
 */
export function normalizarAnosVeiculo(
  anoFabRaw: unknown,
  anoModRaw: unknown,
  anoBase: number,
): { anoFab: string; anoMod: string } {
  const fab = Number.parseInt(String(anoFabRaw ?? ""), 10);
  const mod = Number.parseInt(String(anoModRaw ?? ""), 10);
  const valido = (n: number): boolean => Number.isInteger(n) && n >= 1950 && n <= anoBase + 1;
  const modOk = valido(mod);
  const fabOk = valido(fab);
  // Pelo menos um ano precisa ser decifrável; melhor abortar com mensagem clara
  // do que enviar `0` e colher 6 críticas por seguradora.
  if (!modOk && !fabOk) {
    throw new Error("Ano do veículo não decodificado (placa sem ano de fabricação/modelo válido).");
  }
  const anoModFinal = modOk ? mod : fab; // se só veio um, usa-o nos dois
  let anoFabFinal = fabOk ? fab : anoModFinal;
  // Garante a regra do motor: |fab − mod| ≤ 1.
  if (anoFabFinal > anoModFinal) anoFabFinal = anoModFinal;
  if (anoFabFinal < anoModFinal - 1) anoFabFinal = anoModFinal - 1;
  return { anoFab: String(anoFabFinal), anoMod: String(anoModFinal) };
}

/** Vigência anual padrão (hoje → +1 ano), em ISO. */
function vigenciaAnual(): { ini: string; fim: string } {
  const ini = new Date();
  const fim = new Date(ini);
  fim.setFullYear(fim.getFullYear() + 1);
  return { ini: ini.toISOString(), fim: fim.toISOString() };
}

/** FIPE cru → formato com hífen do HAR (ex.: "0251569" → "025156-9"). PURA. */
export function formatarFipeTxt(fipe: string): string {
  const d = String(fipe ?? "").replace(/\D/g, "");
  return d.length > 1 ? `${d.slice(0, -1)}-${d.slice(-1)}` : d;
}

/**
 * Estima primeira habilitação a partir da data de nascimento (assume habilitado
 * aos 18). O HAR de sucesso traz esses campos preenchidos; não os coletamos, então
 * estimamos. PURA (recebe ano-base). 🚨 VALIDAR-LIVE (impacto no prêmio do jovem).
 */
export function estimarHabilitacao(
  dataNasc: string,
  anoBase: number,
): { dataPrimHabil: string | null; tempoHabilitacao: number | null } {
  const ano = Number.parseInt(String(dataNasc ?? "").slice(0, 4), 10);
  if (!Number.isInteger(ano) || ano < 1900) return { dataPrimHabil: null, tempoHabilitacao: null };
  const anoHab = ano + 18;
  if (anoHab > anoBase) return { dataPrimHabil: null, tempoHabilitacao: 0 };
  return { dataPrimHabil: `${anoHab}-01-01T03:00:00.000Z`, tempoHabilitacao: Math.max(0, anoBase - anoHab) };
}

/**
 * Monta o payload COMPLETO do calcularV2. Função PURA (testável).
 * ✅ Forma confirmada por probe (13/06): `automoveis[]` com condutor PRINCIPAL +
 * campos de topo (tipo/ramo/vigência/tpCobertura/results/loaded/isClearDraft/
 * renovação) + `negocio:null`. Enviar `automovel` singular ou omitir os campos de
 * topo derruba a Lambda (502). O Aggilizador não coleta o questionário → km/
 * garagem ficam NEUTROS (o motor resolve pela FIPE); `valReferenciado`/
 * `combustivel` precisos são refinamento futuro (não bloqueiam o disparo).
 */
export function montarPayloadCalculo(
  segurado: SeguradoPayload,
  calculos: CalculoSeguradora[],
  veiculo: AutomovelPayload,
  entrada: EntradaAggilizador,
): CalcularV2Payload {
  const anoBase = new Date().getFullYear();
  const { dataPrimHabil, tempoHabilitacao } = estimarHabilitacao(segurado.dataNasc, anoBase);
  const condutor: CondutorPayload = {
    relacComSegurado: 1, // o próprio segurado
    tpResidencia: 1,
    dataPrimHabil,
    principal: true,
    cpfCnpj: segurado.cpfCnpj,
    nome: segurado.nome,
    dataNasc: segurado.dataNasc,
    sexo: segurado.sexo,
    estadoCivil: segurado.estadoCivil,
    tempoHabilitacao,
  };
  // Campos do questionário exigidos pelo motor: combustível decodificado quando
  // possível, senão override do operador, senão DEFAULTS (flex). Garagem na
  // RESIDÊNCIA usa override/default; trabalho/estudo vão "0" (confirmado no HAR).
  const garagemResidencia = entrada.garagemResidencia ?? DEFAULTS_AGGILIZADOR.garagem;
  const carro: CarroPayload = {
    descricao: veiculo.modelo ?? "",
    fabricante: veiculo.codFabr ?? null,
    combustivel: veiculo.combustivel ?? entrada.combustivel ?? DEFAULTS_AGGILIZADOR.combustivel,
    anoFabricacao: Number(veiculo.anoFab) || 0,
    anoModelo: Number(veiculo.anoMod) || 0,
    fipe: veiculo.fipe,
    fipeTxt: formatarFipeTxt(veiculo.fipe),
    chassi: veiculo.chassi,
    placa: entrada.placa,
    cepPernoite: entrada.cep,
    kmAnual: entrada.kmMensal != null ? entrada.kmMensal * 12 : DEFAULTS_AGGILIZADOR.kmAnual,
    tpUso: 1, // particular
    zeroKm: entrada.zeroKm,
    tipo: veiculo.tipoVeic || "v",
    residentes: [],
    valReferenciado: veiculo.valReferenciado,
    pctAjuste: entrada.pctAjuste ?? DEFAULTS_AGGILIZADOR.pctAjuste,
    garagemResidencia,
    garagemTrabalho: "0",
    garagemEstudo: "0",
    associado: false,
    periodoUso: "0",
    // Defaults neutros do HAR (o motor recusa se faltarem).
    blindado: false,
    alienado: false,
    kitGas: false,
    rastreador: "0",
    antiFurto: "0",
    gasInstalValor: 0,
    jovemCondutor: false,
    jovemSexo: null,
    jovemIdade: null,
    tipoIsencao: 0,
    idaVoltaTrabalho: null,
    idaVoltaEstudo: null,
    tpLocalPernoite: null,
    dataHoraSaidaLoja: null,
    condutores: [condutor],
  };
  const { ini, fim } = vigenciaAnual();
  const res = (): { errors: unknown[]; successes: unknown[] } => ({ errors: [], successes: [] });
  return {
    cotacao: {
      segurado,
      calculos,
      automoveis: [carro],
      results: { main: res(), alternatives: res(), all: res(), porAssinatura: res(), ofertaCruzada: res() },
      loaded: false,
      isClearDraft: false,
      tipo: 5,
      integracaoInfo: 1,
      vigenciaIni: ini,
      vigenciaFim: fim,
      renovacao: false,
      renovacaoGarantida: false,
      bonusAnterior: 0,
      sinistrosAnterior: 0,
      numeroRenovacao: null,
      seguradoraAnteriorId: null,
      vigFimAnterior: null,
      CI: null,
      tpCobertura: 1,
      ramo: RAMO_AUTO_SUSEP,
    },
    negocio: null,
  };
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
  /** Comissão (%) efetiva da corretora/cotação; sobrepõe a da seguradora. */
  comissaoPadrao?: number | null,
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
  const sessao = await comEtapa("token", () => loginAggilizador(credenciais), "autenticado");
  // Só o Authorization por host; os demais headers (fiéis ao navegador) + TLS +
  // retry/diagnóstico vêm da camada `aggilizador.http`.
  const authProd = authHeader(sessao.tokenPrincipal); // JWT cru (sem "Bearer ")
  const authMc = authHeader(sessao.tokenMulticalculo); // idem — ver authHeader/probe 12/06
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
      // Anos válidos + diferença ≤ 1 ano (senão o motor recusa por seguradora).
      const { anoFab, anoMod } = normalizarAnosVeiculo(v.anoFab, v.anoMod, new Date().getFullYear());
      // Valor FIPE atual (fipeModelo por descrição+ano) → `valReferenciado`. Sem
      // ele as seguradoras recusam (carro R$0 não cota). Best-effort: 0 se falhar.
      let valReferenciado = 0;
      if (v.modelo) {
        const fm = await getMc<FipeModeloItem[]>(
          AGGILIZADOR_MULTICALCULO_API.fipeModelo(v.modelo, v.anoMod),
        ).catch(() => [] as FipeModeloItem[]);
        const valores = (Array.isArray(fm) ? fm[0]?.fipeValores : undefined) ?? [];
        valReferenciado = valores.length ? Number(valores[valores.length - 1]?.valor) || 0 : 0;
      }
      const payload: AutomovelPayload = {
        fipe: v.fipe,
        anoMod,
        anoFab,
        placa: entrada.placa,
        tipoVeic: v.tipoVeic || "v",
        chassi: v.chassi,
        modelo: v.modelo,
        codFabr: v.codFabr,
        valorDeNovo: entrada.zeroKm ? 1 : 0,
        valReferenciado,
        combustivel: null,
      };
      return payload;
    },
    "veículo identificado (FIPE)",
  );

  // 3) calculo — monta calculos[] das seguradoras configuradas e dispara.
  const { idIntegracao, versao } = await comEtapa(
    "calculo",
    async () => {
      // Config das seguradoras (host PROD) + ocultas (escondeLead) + status
      // operacional por ramo (host MULTICÁLCULO). Status é OPCIONAL: se falhar,
      // NÃO filtramos por ramo (fallback) em vez de zerar a cotação.
      const [configs, escondidas, statusSeg] = await Promise.all([
        getProd<SeguradoraConfigItem[]>(AGGILIZADOR_PROD_API.seguradoraConfig),
        getProd<number[]>(AGGILIZADOR_PROD_API.escondeLead).catch(() => [] as number[]),
        getMc<SeguradoraStatusItem[]>(AGGILIZADOR_MULTICALCULO_API.seguradoraStatus).catch(
          () => [] as SeguradoraStatusItem[],
        ),
      ]);
      const { calculos, motivoZero } = selecionarCalculosAuto(
        configs,
        escondidas,
        statusSeg,
        sessao.corretoraId,
        automovel.valorDeNovo,
        // Precedência: comissão da COTAÇÃO (manual) → default da CORRETORA.
        entrada.comissaoPercentual ?? comissaoPadrao,
      );
      if (motivoZero) throw new Error(motivoZero);
      const payload: CalcularV2Payload = montarPayloadCalculo(segurado, calculos, automovel, entrada);
      const resp = await aggPost<CalcularV2Response>(
        `${AGGILIZADOR_PROD_BASE_URL}${AGGILIZADOR_PROD_API.calcularV2}`,
        payload,
        authProd,
        40_000,
      );
      if (!resp.data?.idIntegracao) throw new Error("calcularV2 não retornou idIntegracao.");
      const veic = payload.cotacao.automoveis[0];
      logger.info("[aggilizador] cotação disparada", {
        idIntegracao: resp.data.idIntegracao,
        versao: resp.data.versao,
        seguradoras: calculos.length,
        // Auditável (sem PII): valores neutros efetivamente enviados ao motor.
        veiculo: veic && {
          anoFabricacao: veic.anoFabricacao,
          anoModelo: veic.anoModelo,
          combustivel: veic.combustivel,
          kmAnual: veic.kmAnual,
          garagemResidencia: veic.garagemResidencia,
          pctAjuste: veic.pctAjuste,
        },
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

  // Ordena: principais COTADAS primeiro (por menor prêmio), depois alternativos/
  // assinatura cotados, e por fim recusados. A categoria mantém o comparativo
  // principal alinhado à aba "Pacotes" do Aggilizador (Suhai/assinatura não viram
  // "melhor preço"). NÃO descartamos nada — tudo é persistido e exibido (rotulado).
  const ehPrincipal = (r: ResultadoCotacaoItem): boolean => (r.categoria ?? "principal") === "principal";
  const rank = (r: ResultadoCotacaoItem): number =>
    r.status === "cotado" ? (ehPrincipal(r) ? 0 : 1) : 2;
  const resultados = [...itens.values()]
    .filter((r) => r.status !== "processando")
    .sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      return a.premio_total - b.premio_total;
    });
  // Auditável (sem PII): contagem por categoria das cotadas.
  const cotadas = resultados.filter((r) => r.status === "cotado");
  logger.info("[aggilizador] resultados por categoria", {
    idIntegracao,
    principal: cotadas.filter(ehPrincipal).length,
    alternativo: cotadas.filter((r) => r.categoria === "alternativo").length,
    assinatura: cotadas.filter((r) => r.categoria === "assinatura").length,
    recusadas: resultados.length - cotadas.length,
  });
  return { idIntegracao, versao, resultados };
}
