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
import { SegfyReauthNecessariaError } from "./errors";
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

/** Reseta o cache de tokens (uso em testes). */
export function _resetTokenCache(): void {
  cache = null;
}

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

/**
 * Sessão confiável injetada (vem do banco via segfy-sessao.service): o `cookie` de
 * device trust ("lembrar 30 dias") permite ao /auth/login HTTP pular o 2FA, e os
 * `tokens` persistidos servem de atalho enquanto válidos. O módulo recebe isso
 * como DADO — não conhece Supabase.
 */
export interface SegfySessaoInjetada {
  cookie?: string;
  tokens?: SegfyTokens;
  tokensValidadeMs?: number;
}

/** Margem para reusar tokens persistidos sem nova rede. */
const MARGEM_TOKENS_MS = 5 * 60 * 1000;

export async function obterTokensSegfy(
  forcar = false,
  credenciais?: CredenciaisSegfy,
  sessao?: SegfySessaoInjetada,
): Promise<SegfyTokens> {
  if (!forcar && cache && cache.expiraEm > Date.now()) return cache.tokens;
  // Atalho: tokens persistidos da última reauth ainda confortavelmente válidos.
  if (!forcar && sessao?.tokens && (sessao.tokensValidadeMs ?? 0) > MARGEM_TOKENS_MS) {
    cache = { tokens: sessao.tokens, expiraEm: Date.now() + Math.min(sessao.tokensValidadeMs ?? 0, TOKEN_TTL_MS) };
    return sessao.tokens;
  }
  const env = getEnv();
  // Credenciais: prioriza as injetadas (banco); fallback .env (retrocompat).
  const email = credenciais?.email || env.SEGFY_LOGIN;
  const password = credenciais?.password || env.SEGFY_SENHA;
  // Origin/Referer do SSO: a API key do Firebase tem restrição de referrer.
  // User-Agent de navegador: o cookie de device-trust importado pode ser checado
  // junto do UA — enviamos um UA realista para o /auth/login aceitar a sessão.
  const json = {
    "Content-Type": "application/json",
    Origin: "https://login.segfy.com",
    Referer: "https://login.segfy.com/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  };

  // 1) Firebase verifyPassword → idToken
  const fb = await axios.post<FirebaseVerifyResp>(
    FIREBASE_VERIFY,
    { email, password, returnSecureToken: true },
    { headers: json, timeout: 30_000 },
  );
  const idToken = fb.data.idToken;
  if (!idToken) throw new Error("Segfy: Firebase não retornou idToken (credencial?).");

  // 2) SSO → cookie de sessão (.segfy.com). Junta com o cookie de DEVICE TRUST
  //    (sessão confiável persistida) para o /auth/login dispensar o 2FA.
  const sso = await axios.post(SSO_LOGIN, { idToken }, { headers: json, timeout: 30_000 });
  const cookie = [sessao?.cookie, setCookieToHeader(sso)].filter(Boolean).join("; ");

  // 3) upfygate /auth/login (com o cookie do SSO + device trust) → tokens de automação.
  //    bearer = authAutomationToken (Authorization); config.token = userAutomationToken.
  const up = await axios.post<UpfyLoginResp>(
    `${UPFY_BASE}${SEGFY_ENDPOINTS.auth.login}`,
    { email, password },
    { headers: { ...json, Cookie: cookie }, timeout: 30_000 },
  );
  const d = up.data.data;
  if (!d?.authAutomationToken || !d?.userAutomationToken) {
    // 2FA sem device trust válido. Último recurso: tokens persistidos ainda úteis.
    if (sessao?.tokens && (sessao.tokensValidadeMs ?? 0) > 60_000) {
      cache = { tokens: sessao.tokens, expiraEm: Date.now() + (sessao.tokensValidadeMs ?? 60_000) };
      return sessao.tokens;
    }
    throw new SegfyReauthNecessariaError();
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

/** Uma seguradora configurada na conta Segfy (para curadoria no Admin). */
export interface SeguradoraSegfy {
  /** `name` técnico usado em config.insurers (ex.: "mapfre"). */
  codigo: string;
  /** Rótulo amigável para a tela. */
  nome: string;
  /** Comissão padrão (%) — usada em config.insurers se a seguradora for cotada. */
  comissao: number;
}

/** Normaliza a resposta do company-list (formato varia: array, {data:[]}, {data:{companies:[]}}). */
function extrairListaSeguradoras(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const d = (raw as { data?: unknown }).data;
    if (Array.isArray(d)) return d;
    if (d && typeof d === "object") {
      const c =
        (d as { companies?: unknown }).companies ??
        (d as { seguradoras?: unknown }).seguradoras ??
        (d as { list?: unknown }).list;
      if (Array.isArray(c)) return c;
    }
  }
  return [];
}

/**
 * Lista as seguradoras configuradas na conta Segfy (vehicleCompanyList). Alimenta
 * a curadoria no Admin (quais cotar). Defensiva quanto ao formato da resposta —
 * o endpoint não foi capturado ponta-a-ponta, então aceitamos chaves alternativas.
 */
export async function listarSeguradorasSegfy(credenciais?: CredenciaisSegfy): Promise<SeguradoraSegfy[]> {
  const tk = await obterTokensSegfy(false, credenciais);
  const raw = await post<unknown>(
    SEGFY_AUTOMATION_API.vehicleCompanyList,
    { data: { vehicle_type: "car" }, config: { token: tk.automationToken } },
    tk,
  );
  const out: SeguradoraSegfy[] = [];
  const vistos = new Set<string>();
  for (const item of extrairListaSeguradoras(raw)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const codigo = String(o.name ?? o.codigo ?? o.id ?? "").trim().toLowerCase();
    if (!codigo || vistos.has(codigo)) continue;
    vistos.add(codigo);
    const nome = String(o.nome ?? o.full_name ?? o.name ?? codigo).trim();
    const comissaoNum = Number(o.commission ?? o.comissao);
    out.push({ codigo, nome, comissao: Number.isFinite(comissaoNum) ? comissaoNum : 15 });
  }
  return out;
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

/** Remove CPF (11 dígitos) e corta o comprimento. Nunca lança. */
function sanitizar(s: string, max = 180): string {
  return s.replace(/\b\d{11}\b/g, "***").slice(0, max);
}

/**
 * Mensagem curta de erro — NUNCA token/CPF. Para erros HTTP do Segfy (axios),
 * extrai o MOTIVO REAL do corpo da resposta (message/error/errors[]…), que o
 * axios esconde atrás de "Request failed with status code NNN". Robusta: se o
 * corpo vier em formato inesperado, cai para `e.message`.
 */
export function erroCurto(e: unknown): string {
  try {
    if (axios.isAxiosError(e)) {
      const status = e.response?.status;
      const data = e.response?.data as
        | { message?: string; error?: string; errors?: unknown; detail?: string; title?: string }
        | string
        | undefined;
      let motivo = "";
      if (typeof data === "string") motivo = data;
      else if (data) {
        motivo =
          (typeof data.message === "string" && data.message) ||
          (typeof data.error === "string" && data.error) ||
          (typeof data.detail === "string" && data.detail) ||
          (typeof data.title === "string" && data.title) ||
          (data.errors != null ? (typeof data.errors === "string" ? data.errors : JSON.stringify(data.errors)) : "");
      }
      const prefixo = status ? `HTTP ${status}` : "erro de rede";
      return sanitizar(motivo ? `${prefixo}: ${motivo}` : `${prefixo}: ${e.message}`);
    }
  } catch {
    /* formato inesperado → cai no fallback abaixo */
  }
  const m = e instanceof Error ? e.message : String(e);
  return sanitizar(m);
}

export async function cotarAuto(
  dados: DadosCotacaoAuto,
  tokens?: SegfyTokens,
  onEtapa?: (e: EtapaEvento) => void,
  credenciais?: CredenciaisSegfy,
  sessao?: SegfySessaoInjetada,
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
      // Diagnóstico: loga o CORPO da resposta de erro do Segfy (sanitizado, sem
      // CPF/token) para identificar a validação que falhou (ex.: 422 do calculate).
      if (axios.isAxiosError(e)) {
        const body = typeof e.response?.data === "string" ? e.response.data : JSON.stringify(e.response?.data ?? {});
        logger.warn("[segfy] resposta de erro", { etapa, status: e.response?.status, body: sanitizar(body, 800) });
      }
      emit({ etapa, status: "erro", mensagem: erroCurto(e) });
      throw e;
    }
  }

  const insurers = dados.insurers ?? INSURERS_PADRAO;

  // 0) token de automação. Emite SEMPRE andamento→ok (inclusive no reuso de
  // token) via comEtapa — emissão simétrica evita "ok sem andamento" que
  // confundia a leitura da etapa "Autenticação no Segfy".
  const tk = await comEtapa(
    "token",
    async () => tokens ?? (await obterTokensSegfy(false, credenciais, sessao)),
    tokens ? "token reutilizado" : "autenticado no Segfy",
  );
  const { automationToken: token } = tk;

  // 1) segurado + veículo
  const ins = await comEtapa(
    "segurado",
    async () => {
      const r = (await post<InsuredResp>(SEGFY_AUTOMATION_API.insured, { data: { document: dados.cpf }, config: { token } }, tk)).data;
      // Guard: um CPF inválido pode retornar objeto vazio (sem nome/nascimento),
      // que só estouraria 422 lá no /calculate. Falha aqui com motivo claro.
      if (!r || !r.name || !r.birth_date) {
        // Diagnóstico (sem PII): distingue "CPF errado" de "insured não retorna
        // dados p/ CPF válido" (→ aciona coleta de nascimento/sexo no futuro).
        logger.warn("[segfy] insured vazio", { insured_vazio: true, cpf_len: dados.cpf.replace(/\D/g, "").length });
        throw new Error("Não localizei os dados do segurado para este CPF (verifique o CPF informado).");
      }
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
