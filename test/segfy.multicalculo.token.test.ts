/**
 * Emissão simétrica da etapa "token" no cotarAuto.
 *
 * Regressão do bug do painel "Etapas Segfy": no caminho de TOKEN REUTILIZADO o
 * código antigo emitia só `token:ok` (sem `andamento`), deixando a leitura da
 * etapa "Autenticação no Segfy" inconsistente. Agora ambos os caminhos passam
 * por comEtapa → andamento→ok. Mocka rede (axios), socket e o parser de RESULT
 * para exercitar cotarAuto sem I/O real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("axios", () => {
  const post = vi.fn(async (url: string) => {
    if (url.includes("/insured"))
      return { data: { data: { id: "seg1", name: "Fulano", birth_date: "1990-01-01", gender: "male", email: "", cellphone: "" } } };
    if (url.includes("/decode-plate"))
      return {
        data: {
          data: {
            manufacture_year: 2022,
            model_year: 2022,
            chassis: "CHASSI",
            brands: [{ id: "1", value: "VW" }],
            models: [{ model_id: "m1", value: "Polo", fuel_type: "flex", zero_km: false, data_fipe: { fipe_code: "001", fipe_value: 50000, fipe_url: "u" } }],
          },
        },
      };
    if (url.includes("/calculate")) return { data: { status: "OK", data: { quotation_id: "q-1" } } };
    throw new Error(`axios.post não mockado: ${url}`);
  });
  return { default: { post, isAxiosError: () => false }, isAxiosError: () => false };
});

vi.mock("socket.io-client", () => ({
  // Ao registrar onAny, agenda 1 evento RESULT (insurers tem length 1 → resolve).
  io: vi.fn(() => ({
    onAny(cb: (evento: string, payload: unknown) => void) {
      setTimeout(() => cb("message", { action: "RESULT", data: { seguradora: "X" } }), 5);
    },
    close: vi.fn(),
  })),
}));

vi.mock("../src/integrations/segfy/segfy.resultado", () => ({
  mapearResultadoParaItem: vi.fn(() => ({
    seguradora: "X",
    premio_total: 100,
    parcelas: 10,
    valor_parcela: 10,
    coberturas_resumo: "completa",
    status: "cotado",
  })),
}));

import { cotarAuto, type DadosCotacaoAuto, type SegfyTokens, type EtapaEvento } from "../src/integrations/segfy/segfy.multicalculo";

const dados: DadosCotacaoAuto = {
  cpf: "00000000000",
  placa: "ABC1D23",
  cep: "80000000",
  insurers: [{ name: "x", commission: 0 }], // length 1 → coleta resolve com 1 RESULT
};
const tokens: SegfyTokens = { bearer: "Bearer jwt", automationToken: "atk" };

beforeEach(() => vi.clearAllMocks());

describe("cotarAuto — emissão da etapa token", () => {
  it("TOKEN REUTILIZADO emite andamento→ok (não só ok)", async () => {
    const eventos: EtapaEvento[] = [];
    await cotarAuto(dados, tokens, (e) => eventos.push({ ...e }));

    const token = eventos.filter((e) => e.etapa === "token");
    expect(token.map((e) => e.status)).toEqual(["andamento", "ok"]);
    expect(token[1]?.mensagem).toBe("token reutilizado");
  });

  it("registra a sequência completa do pipeline em ordem", async () => {
    const eventos: EtapaEvento[] = [];
    const { resultados, quotationId } = await cotarAuto(dados, tokens, (e) => eventos.push({ ...e }));

    // Cada etapa fecha em 'ok' (nenhum 'andamento' órfão no caminho feliz).
    for (const etapa of ["token", "segurado", "veiculo", "calculo", "coleta"] as const) {
      const ult = [...eventos].reverse().find((e) => e.etapa === etapa);
      expect(ult?.status, `etapa ${etapa}`).toBe("ok");
    }
    expect(quotationId).toBe("q-1");
    expect(resultados).toHaveLength(1);
  });
});
