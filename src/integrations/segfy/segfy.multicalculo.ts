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
import axios from "axios";
import { chromium } from "playwright";
import { io } from "socket.io-client";
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import { SEGFY_AUTOMATION_API, SEGFY_AUTOMATION_BASE_URL, SEGFY_RESULTS_WS_URL } from "./endpoints";
import { mapearResultadoParaItem } from "./segfy.resultado";
import type { ResultadoCotacaoItem } from "./segfy.types";

const SOCKET_ORIGIN = "https://socket-io.segfy.com";
const COBERTURA_PADRAO_ID = "4b620414-68ec-4dd5-b10f-406e1a7ead3a";
const TIMEOUT_RESULTADOS_MS = 120_000;

export interface SegfyTokens {
  bearer: string; // JWT (header Authorization)
  automationToken: string; // config.token
}

export interface DadosCotacaoAuto {
  cpf: string;
  placa: string;
  cep: string;
  profissao?: string;
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

/** Login SSO (Playwright) e captura do bearer + token de automação. */
export async function obterTokensSegfy(): Promise<SegfyTokens> {
  const env = getEnv();
  const browser = await chromium.launch({ headless: env.SEGFY_HEADLESS });
  try {
    const page = await browser
      .newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      })
      .then((c) => c.newPage());

    let bearer = "";
    let automationToken = "";
    page.on("request", (req) => {
      const u = req.url();
      if (u.includes("api.automation.segfy.com") || u.includes("upfygate.segfy.com")) {
        const a = req.headers()["authorization"];
        if (a?.toLowerCase().startsWith("bearer ") && (!bearer || u.includes("api.automation"))) bearer = a;
      }
    });
    page.on("response", async (resp) => {
      if (resp.url().includes("find-by-user")) {
        try {
          const j = (await resp.json()) as { data?: { token?: string } };
          if (j.data?.token) automationToken = j.data.token;
        } catch {
          /* ignore */
        }
      }
    });

    const base = env.SEGFY_APP_URL.replace(/\/+$/, "");
    await page.goto(`${base}/login`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    await page.locator("input:not([type=password])").first().fill(env.SEGFY_LOGIN);
    await page.locator('input[type="password"]').first().fill(env.SEGFY_SENHA);
    await page.locator('input[type="password"]').first().press("Enter");
    await page.waitForURL((u) => u.href.includes("app.segfy.com") && !u.href.includes("login"), { timeout: 25_000 });
    // Abre o multicálculo p/ disparar as chamadas da api.automation (captura o bearer).
    await page.goto(`${base}/multicalculo/hfy-auto`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => undefined);
    for (let i = 0; i < 20 && !(bearer && automationToken); i++) await page.waitForTimeout(1_000);

    if (!bearer || !automationToken) {
      throw new Error("Segfy: não capturei bearer/automationToken (2FA? credencial? layout?).");
    }
    logger.info("Segfy multicálculo: tokens obtidos");
    return { bearer, automationToken };
  } finally {
    await browser.close();
  }
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
export async function cotarAuto(
  dados: DadosCotacaoAuto,
  tokens: SegfyTokens,
): Promise<ResultadoCotacaoItem[]> {
  const { automationToken: token } = tokens;
  const insurers = dados.insurers ?? INSURERS_PADRAO;

  // 1) segurado + veículo
  const ins = (await post<InsuredResp>(SEGFY_AUTOMATION_API.insured, { data: { document: dados.cpf }, config: { token } }, tokens)).data;
  if (!ins) throw new Error("Segfy: segurado não encontrado para o CPF informado");
  const dec = (await post<DecodePlateResp>(SEGFY_AUTOMATION_API.decodePlate, { data: { plate: dados.placa }, config: { token } }, tokens)).data;
  if (!dec || !dec.brands[0] || !dec.models[0]) throw new Error("Segfy: placa não decodificada");
  const brand = dec.brands[0];
  const model = dec.models[0];

  // 2) payload do calculate (estrutura confirmada na captura)
  const callback = randomUUID();
  const now = new Date();
  const fim = new Date(now);
  fim.setFullYear(fim.getFullYear() + 1);
  const payload = {
    data: {
      renewal: { quotation_type: "NEW_QUOTATION", insurer: "new", prior_policy: "", claim_amount: "", prior_policy_end: "", bonus_current: " ", prior_ic: "", bonus_last: " " },
      zip_code: dados.cep.replace(/\D/g, ""),
      validity_start: now.toISOString(),
      validity_end: fim.toISOString(),
      customer: { cellphone: ins.cellphone, email: ins.email, document: dados.cpf, sex: ins.gender, birth_date: ins.birth_date, name: ins.name, social_name: "" },
      main_driver: { relationship: "himself", marital_status: "single", document: dados.cpf, profession: dados.profissao ?? "Administrador", name: ins.name, birth_date: ins.birth_date, sex: ins.gender },
      vehicle: { circulation_zip_code: "", fuel_type: model.fuel_type, model: model.value, model_year: String(dec.model_year), manufacture_year: String(dec.manufacture_year), brand: brand.value, chassis: dec.chassis, plate: dados.placa.replace(/\W/g, ""), vehicle_type: "car", zero_km: model.zero_km, category_type: "particular", fipe_code: model.data_fipe.fipe_code, fipe_value: model.data_fipe.fipe_value, alienated: false, gas_kit: false, armored: false, chassis_relabeled: false, anti_theft: false, fipe_url: model.data_fipe.fipe_url },
      questionnaire: { residence_garage: "yes_with_electronic_gate", job_garage: "no", study_garage: "no", utilization_type: "personal", other_driver: "does_not_exist", secondary_driver_age: " ", monthly_km: "500", work_distance: "5", residence_type: "house", tax_exemption: "not_isent" },
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
  const calc = await post<CalcResp>(SEGFY_AUTOMATION_API.calculate, payload, tokens);
  logger.info("Segfy: cotação disparada", { quotationId: calc.data?.quotation_id, seguradoras: insurers.length });

  await coleta;
  socket.close();

  // Ordena: cotadas primeiro, por menor prêmio.
  return [...itens.values()].sort((a, b) => {
    if (a.status === "cotado" && b.status !== "cotado") return -1;
    if (b.status === "cotado" && a.status !== "cotado") return 1;
    return a.premio_total - b.premio_total;
  });
}
