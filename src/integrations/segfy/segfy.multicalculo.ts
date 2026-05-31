/**
 * Multicálculo Auto (HFy) — fluxo LIVE, ✅ validado ponta-a-ponta (30/05/2026).
 *
 * Sequência confirmada:
 *   1) obterTokens(): login SSO via Playwright → captura bearer (JWT, header
 *      Authorization da api.automation) + token de automação (find-by-user).
 *   2) insured(cpf) → dados do segurado; decode-plate(placa) → veículo+FIPE.
 *   3) calculate(payload, config:{insurers, callback, token}) → quotation_id.
 *   4) Socket.IO (auth:{roomId:callback}) recebe eventos RESULT por seguradora.
 *   5) mapearResultadoParaItem → ResultadoCotacaoItem[] (o bot formata p/ WhatsApp).
 *
 * api.automation exige Authorization: Bearer <jwt> ALÉM do config.token.
 * Nunca logamos token/CPF.
 */
import { randomUUID } from "node:crypto";
import axios, { type AxiosResponse } from "axios";
import { io } from "socket.io-client";
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import { SEGFY_AUTOMATION_API, SEGFY_AUTOMATION_BASE_URL, SEGFY_ENDPOINTS } from "./endpoints";
import { mapearResultadoParaItem } from "./segfy.resultado";
import type { ResultadoCotacaoItem } from "./segfy.types";

const SOCKET_ORIGIN = "https://socket-io.segfy.com";
const COBERTURA_PADRAO_ID = "4b620414-68ec-4dd5-b10f-406e1a7ead3a";
const TIMEOUT_RESULTADOS_MS = 120_000;

// Login 100% HTTP (sem browser) via Firebase. A API key é a chave web PÚBLICA
// do Segfy (embutida no client) — não é segredo.
const FIREBASE_WEB_KEY = "AIzaSyBqZi-53TxYuo-uvNDUMS1LbM6OsKB7dQc";
const FIREBASE_VERIFY = `https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key=${FIREBASE_WEB_KEY}`;
const SSO_LOGIN = "https://api.sso.segfy.com/login";
const UPFY_BASE = "https://upfygate.segfy.com";
/** Validade do cache de token (idToken Firebase expira em 3600s; margem de 10min). */
const TOKEN_TTL_MS = 50 * 60 * 1000;

export interface SegfyTokens {
  bearer: string; // JWT (header Authorization)
  automationToken: string; // config.token
}

/** Questionário do Segfy (chaves/enums já no formato da API). */
export interface QuestionarioSegfy {
  residence_garage: string; // yes_with_electronic_gate | yes | no
  job_garage: string; // yes | no
  study_garage: string; // yes | no
  utilization_type: string; // personal | app | ...
  other_driver: string; // does_not_exist | exists
  secondary_driver_age: string;
  monthly_km: string;
  work_distance: string;
  residence_type: string; // house | apartment
  tax_exemption: string; // not_isent | isent
}

/** Questionário-padrão (valores CONFIRMADOS que a API aceita). Servem de base;
 * o mapeador do bot sobrescreve o que o cliente respondeu. */
export const QUESTIONARIO_PADRAO: QuestionarioSegfy = {
  residence_garage: "yes_with_electronic_gate",
  job_garage: "no",
  study_garage: "no",
  utilization_type: "personal",
  other_driver: "does_not_exist",
  secondary_driver_age: " ",
  monthly_km: "500",
  work_distance: "5",
  residence_type: "house",
  tax_exemption: "not_isent",
};

export interface DadosCotacaoAuto {
  cpf: string;
  placa: string;
  cep: string;
  profissao?: string;
  /** estado civil já mapeado p/ a chave Segfy (single/married/...). */
  maritalStatus?: string;
  /** uso já mapeado (particular/aplicativo/...). */
  categoryType?: string;
  /** bônus de classe (0-10). */
  bonus?: number;
  /** respostas do questionário (sobrescrevem o QUESTIONARIO_PADRAO). */
  questionario?: Partial<QuestionarioSegfy>;
  /** flags do veículo (sobrescrevem os defaults do decode-plate). */
  vehicleFlags?: Partial<{ alienated: boolean; gas_kit: boolean; armored: boolean; chassis_relabeled: boolean; anti_theft: boolean }>;
  insurers?: Array<{ name: string; commission: number }>;
}

const INSURERS_PADRAO: Array<{ name: string; commission: number }> = [
  { name: "mapfre", commission: 15 },
  { name: "liberty", commission: 15 },
  { name: "aliro", commission: 15 },
];

interface InsuredResp {
  data?: { id: string; name: string; birth_date: string; gender: string; email: string; cellphone: string };
}
interface ModeloFipe {
  model_id: string; value: string; fuel_type: string; zero_km: boolean;
  data_fipe: { fipe_code: string; fipe_value: number; fipe_url: string };
}
interface DecodePlateResp {
  data?: { manufacture_year: number; model_year: number; chassis: string; brands: Array<{ id: string; value: string }>; models: ModeloFipe[] };
}
interface CalcResp { status: string; data?: { quotation_id: string } }

interface FirebaseVerifyResp { idToken?: string }
interface UpfyLoginResp {
  data?: { authAutomationToken?: string; userAutomationToken?: string };
}

function setCookieToHeader(resp: AxiosResponse): string {
  const sc = resp.headers["set-cookie"];
  return Array.isArray(sc) ? sc.map((c) => c.split(";")[0]).join("; ") : "";
}

let cache: { tokens: SegfyTokens; expiraEm: number } | null = null;

/**
 * Login Segfy 100% via HTTP (SEM browser): Firebase verifyPassword → SSO →
 * upfygate /auth/login (com o cookie do SSO) → find-by-user. Cacheia o token.
 *
 * ⚠️ 2FA (a partir de 01/06/2026): o SSO pode exigir código por e-mail; nesse
 * caso usar usuário de serviço isento (Configurações > Usuários) ou Gmail OTP.
 */
/** Credenciais do portal (vêm do banco/serviço; default = .env). */
export interface CredenciaisSegfy {
  email: string;
  password: string;
}

export async function obterTokensSegfy(
  forcar = false,
  credenciais?: CredenciaisSegfy,
): Promise<SegfyTokens> {
  if (!forcar && cache && cache.expiraEm > Date.now()) return cache.tokens;
  const env = getEnv();
  // Credenciais: prioriza as injetadas (banco); fallback .env (retrocompat).
  const email = credenciais?.email || env.SEGFY_LOGIN;
  const password = credenciais?.password || env.SEGFY_SENHA;
  // Origin/Referer do SSO: a API key do Firebase tem restrição de referrer.
  const json = {
    "Content-Type": "application/json",
    Origin: "https://login.segfy.com",
    Referer: "https://login.segfy.com/",
  };

  // 1) Firebase verifyPassword → idToken
  const fb = await axios.post<FirebaseVerifyResp>(
    FIREBASE_VERIFY,
    { email, password, returnSecureToken: true },
    { headers: json, timeout: 30_000 },
  );
  const idToken = fb.data.idToken;
  if (!idToken) throw new Error("Segfy: Firebase não retornou idToken (credencial?).");

  // 2) SSO → cookie de sessão (.segfy.com)
  const sso = await axios.post(SSO_LOGIN, { idToken }, { headers: json, timeout: 30_000 });
  const cookie = setCookieToHeader(sso);

  // 3) upfygate /auth/login (com o cookie do SSO) → já traz os tokens de automação.
  //    bearer = authAutomationToken (Authorization); config.token = userAutomationToken.
  //    (Não é preciso find-by-user — esses tokens vêm direto no login.)
  const up = await axios.post<UpfyLoginResp>(
    `${UPFY_BASE}${SEGFY_ENDPOINTS.auth.login}`,
    { email, password },
    { headers: { ...json, Cookie: cookie }, timeout: 30_000 },
  );
  const d = up.data.data;
  if (!d?.authAutomationToken || !d?.userAutomationToken) {
    throw new Error("Segfy: /auth/login não retornou tokens de automação (2FA? SSO?).");
  }
  const tokens: SegfyTokens = {
    bearer: `Bearer ${d.authAutomationToken}`,
    automationToken: d.userAutomationToken,
  };
  cache = { tokens, expiraEm: Date.now() + TOKEN_TTL_MS };
  logger.info("Segfy multicálculo: tokens obtidos (HTTP, sem browser)");
  return tokens;
}

function headers(tokens: SegfyTokens): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Origin: "https://gestao.segfy.com",
    Referer: "https://gestao.segfy.com/",
    Authorization: tokens.bearer,
  };
}

async function post<T>(path: string, body: unknown, tokens: SegfyTokens): Promise<T> {
  const r = await axios.post<T>(`${SEGFY_AUTOMATION_BASE_URL}${path}`, body, {
    headers: headers(tokens),
    timeout: 40_000,
  });
  return r.data;
}

/**
 * Dispara a cotação Auto e coleta os resultados por seguradora via WebSocket.
 * Resolve quando todas as seguradoras responderem ou no timeout.
 */
export interface ResultadoCotacaoAuto {
  quotationId: string | null;
  resultados: ResultadoCotacaoItem[];
}

/** Etapa do pipeline Segfy, emitida para observabilidade (área de consulta). */
export interface EtapaEvento {
  etapa: "token" | "segurado" | "veiculo" | "calculo" | "coleta";
  status: "andamento" | "ok" | "erro";
  mensagem?: string;
}

/** Mensagem curta de erro — NUNCA token/CPF. */
function erroCurto(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\b\d{11}\b/g, "***").slice(0, 140);
}

export async function cotarAuto(
  dados: DadosCotacaoAuto,
  tokens?: SegfyTokens,
  onEtapa?: (e: EtapaEvento) => void,
  credenciais?: CredenciaisSegfy,
): Promise<ResultadoCotacaoAuto> {
  const emit = (e: EtapaEvento): void => {
    try {
      onEtapa?.(e);
    } catch {
      /* observabilidade nunca quebra a cotação */
    }
  };
  async function comEtapa<T>(etapa: EtapaEvento["etapa"], fn: () => Promise<T>, okMsg?: string): Promise<T> {
    emit({ etapa, status: "andamento" });
    try {
      const r = await fn();
      emit({ etapa, status: "ok", mensagem: okMsg });
      return r;
    } catch (e) {
      emit({ etapa, status: "erro", mensagem: erroCurto(e) });
      throw e;
    }
  }

  const insurers = dados.insurers ?? INSURERS_PADRAO;

  // 0) token de automação
  const tk = tokens ?? (await comEtapa("token", () => obterTokensSegfy(false, credenciais), "autenticado no Segfy"));
  if (tokens) emit({ etapa: "token", status: "ok", mensagem: "token reutilizado" });
  const { automationToken: token } = tk;

  // 1) segurado + veículo
  const ins = await comEtapa(
    "segurado",
    async () => {
      const r = (await post<InsuredResp>(SEGFY_AUTOMATION_API.insured, { data: { document: dados.cpf }, config: { token } }, tk)).data;
      if (!r) throw new Error("segurado não encontrado para o CPF informado");
      return r;
    },
    "segurado localizado",
  );
  const { brand, model, dec } = await comEtapa(
    "veiculo",
    async () => {
      const d = (await post<DecodePlateResp>(SEGFY_AUTOMATION_API.decodePlate, { data: { plate: dados.placa }, config: { token } }, tk)).data;
      if (!d || !d.brands[0] || !d.models[0]) throw new Error("placa não decodificada");
      return { brand: d.brands[0], model: d.models[0], dec: d };
    },
    "veículo identificado (FIPE)",
  );

  // 2) payload do calculate (estrutura confirmada na captura)
  const callback = randomUUID();
  const now = new Date();
  const fim = new Date(now);
  fim.setFullYear(fim.getFullYear() + 1);
  const payload = {
    data: {
      renewal: { quotation_type: "NEW_QUOTATION", insurer: "new", prior_policy: "", claim_amount: "", prior_policy_end: "", bonus_current: dados.bonus != null ? String(dados.bonus) : " ", prior_ic: "", bonus_last: " " },
      zip_code: dados.cep.replace(/\D/g, ""),
      validity_start: now.toISOString(),
      validity_end: fim.toISOString(),
      customer: { cellphone: ins.cellphone, email: ins.email, document: dados.cpf, sex: ins.gender, birth_date: ins.birth_date, name: ins.name, social_name: "" },
      main_driver: { relationship: "himself", marital_status: dados.maritalStatus ?? "single", document: dados.cpf, profession: dados.profissao ?? "Administrador", name: ins.name, birth_date: ins.birth_date, sex: ins.gender },
      vehicle: { circulation_zip_code: "", fuel_type: model.fuel_type, model: model.value, model_year: String(dec.model_year), manufacture_year: String(dec.manufacture_year), brand: brand.value, chassis: dec.chassis, plate: dados.placa.replace(/\W/g, ""), vehicle_type: "car", zero_km: model.zero_km, category_type: dados.categoryType ?? "particular", fipe_code: model.data_fipe.fipe_code, fipe_value: model.data_fipe.fipe_value, alienated: false, gas_kit: false, armored: false, chassis_relabeled: false, anti_theft: false, ...dados.vehicleFlags, fipe_url: model.data_fipe.fipe_url },
      questionnaire: { ...QUESTIONARIO_PADRAO, ...dados.questionario },
      questionnaire_truck: {},
      coverage: { fipe_percentage: "100", selected_coverage: { label: "PADRAO", value: COBERTURA_PADRAO_ID }, description: "PADRAO", coverage_type: "comprehensive", franchise: "reduced_50", assistance: "assistance_500_km_referenced", glass: "glass_total_referenced", rental_car: "rental_car_07_days_referenced", rental_car_profile: "basic", replacement_zero_km: "no_replacement", material_damage: "200000.00", body_injuries: "200000.00", moral_damage: "0.00", death_illness: "10000.00", expense_extraordinary: "0", dmh: "0", maxpar_coverages: { bodywork_and_paint: false, wheel_tire_and_suspension: false }, lmi_residential: "0", defense_costs: "0", quick_repairs: false, body_shop_repair: false, exemption_franchise: false },
      alive_extension: "false",
      model_id: model.value,
      brand_id: brand.id,
      quotation_date: now.toISOString().slice(0, 10),
    },
    config: { insurers, callback, extension_guid: null, extension_version: null, connected_backup: null, token },
  };

  // 3) socket (entra na sala via auth.roomId) ANTES do disparo
  const socket = io(SOCKET_ORIGIN, { transports: ["websocket"], auth: { roomId: callback } });
  const itens = new Map<string, ResultadoCotacaoItem>();

  const coleta = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, TIMEOUT_RESULTADOS_MS);
    socket.onAny((_evento: string, payloadEvt: unknown) => {
      const evt = payloadEvt as { action?: string; data?: unknown } | undefined;
      if (evt?.action !== "RESULT") return;
      try {
        const item = mapearResultadoParaItem(evt.data);
        itens.set(item.seguradora, item);
      } catch (e) {
        logger.warn("Segfy: RESULT não parseável", { erro: e instanceof Error ? e.message : String(e) });
      }
      // Resolve assim que todas as seguradoras pedidas responderem.
      if (itens.size >= insurers.length) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  await new Promise((r) => setTimeout(r, 1_000)); // garante a conexão antes do disparo
  const calc = await comEtapa(
    "calculo",
    () => post<CalcResp>(SEGFY_AUTOMATION_API.calculate, payload, tk),
    `cálculo disparado em ${insurers.length} seguradoras`,
  ).catch((e) => {
    socket.close();
    throw e;
  });
  logger.info("Segfy: cotação disparada", { quotationId: calc.data?.quotation_id, seguradoras: insurers.length });

  emit({ etapa: "coleta", status: "andamento" });
  await coleta;
  socket.close();
  emit({ etapa: "coleta", status: "ok", mensagem: `${itens.size} de ${insurers.length} seguradoras responderam` });

  // Ordena: cotadas primeiro, por menor prêmio.
  const resultados = [...itens.values()].sort((a, b) => {
    if (a.status === "cotado" && b.status !== "cotado") return -1;
    if (b.status === "cotado" && a.status !== "cotado") return 1;
    return a.premio_total - b.premio_total;
  });
  return { quotationId: calc.data?.quotation_id ?? null, resultados };
}
