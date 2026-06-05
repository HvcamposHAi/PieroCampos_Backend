/**
 * Contorno do 2FA no login HTTP (obterTokensSegfy) + propagação do erro de reauth
 * pela etapa "token" do cotarAuto. Mocka axios/socket para exercitar sem rede.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const post = vi.hoisted(() =>
  vi.fn(async (url: string) => {
    if (url.includes("identitytoolkit")) return { data: { idToken: "id-1" } };
    if (url.includes("api.sso.segfy.com")) return { data: {}, headers: { "set-cookie": ["s=1; Path=/"] } };
    if (url.includes("/auth/login")) return { data: { data: {} } }; // 2FA: SEM tokens de automação
    if (url.includes("/insured"))
      return { data: { data: { id: "seg1", name: "F", birth_date: "1990-01-01", gender: "male", email: "", cellphone: "" } } };
    if (url.includes("/decode-plate"))
      return { data: { data: { manufacture_year: 2022, model_year: 2022, chassis: "C", brands: [{ id: "1", value: "VW" }], models: [{ model_id: "m", value: "Polo", fuel_type: "flex", zero_km: false, data_fipe: { fipe_code: "1", fipe_value: 1, fipe_url: "u" } }] } } };
    if (url.includes("/calculate")) return { data: { status: "OK", data: { quotation_id: "q-1" } } };
    throw new Error(`axios.post não mockado: ${url}`);
  }),
);

vi.mock("axios", () => ({ default: { post, isAxiosError: () => false }, isAxiosError: () => false }));

vi.mock("socket.io-client", () => ({
  io: vi.fn(() => ({
    onAny(cb: (e: string, p: unknown) => void) {
      setTimeout(() => cb("m", { action: "RESULT", data: { seguradora: "X" } }), 5);
    },
    close: vi.fn(),
  })),
}));

vi.mock("../src/integrations/segfy/segfy.resultado", () => ({
  mapearResultadoParaItem: vi.fn(() => ({ seguradora: "X", premio_total: 1, parcelas: 1, valor_parcela: 1, coberturas_resumo: "c", status: "cotado" })),
}));

import {
  obterTokensSegfy,
  cotarAuto,
  _resetTokenCache,
  type SegfyTokens,
  type DadosCotacaoAuto,
  type EtapaEvento,
} from "../src/integrations/segfy/segfy.multicalculo";
import { SegfyReauthNecessariaError, MSG_REAUTH_NECESSARIA } from "../src/integrations/segfy/errors";

const CREDS = { email: "a@b.com", password: "x" };
const TOKENS_PERSIST: SegfyTokens = { bearer: "Bearer atk", automationToken: "utk" };
const dados: DadosCotacaoAuto = { cpf: "00000000000", placa: "ABC1D23", cep: "80000000", insurers: [{ name: "x", commission: 0 }] };

beforeEach(() => {
  _resetTokenCache();
  vi.clearAllMocks();
});

describe("obterTokensSegfy — 2FA / sessão", () => {
  it("sem tokens no /auth/login E sem sessão → lança SegfyReauthNecessariaError", async () => {
    await expect(obterTokensSegfy(true, CREDS)).rejects.toBeInstanceOf(SegfyReauthNecessariaError);
  });

  it("2FA mas com tokens persistidos válidos → usa os persistidos (último recurso)", async () => {
    const tk = await obterTokensSegfy(true, CREDS, { tokens: TOKENS_PERSIST, tokensValidadeMs: 10 * 60_000 });
    expect(tk).toEqual(TOKENS_PERSIST);
  });

  it("atalho: tokens persistidos confortavelmente válidos → NÃO faz rede", async () => {
    const tk = await obterTokensSegfy(false, CREDS, { tokens: TOKENS_PERSIST, tokensValidadeMs: 10 * 60_000 });
    expect(tk).toEqual(TOKENS_PERSIST);
    expect(post).not.toHaveBeenCalled();
  });

  it("injeta o cookie de device trust no /auth/login", async () => {
    await obterTokensSegfy(true, CREDS, { cookie: "trust=abc" }).catch(() => undefined);
    const chamadaLogin = post.mock.calls.find((c) => String(c[0]).includes("/auth/login"));
    const headers = (chamadaLogin?.[2] as { headers?: { Cookie?: string } } | undefined)?.headers;
    expect(headers?.Cookie).toContain("trust=abc");
  });
});

describe("cotarAuto — etapa token com reauth necessária", () => {
  it("propaga SegfyReauthNecessariaError e emite token/erro com a mensagem amigável", async () => {
    const eventos: EtapaEvento[] = [];
    await expect(cotarAuto(dados, undefined, (e) => eventos.push({ ...e }), CREDS)).rejects.toBeInstanceOf(
      SegfyReauthNecessariaError,
    );
    const tokenErro = eventos.find((e) => e.etapa === "token" && e.status === "erro");
    expect(tokenErro?.mensagem).toBe(MSG_REAUTH_NECESSARIA);
  });
});
