/**
 * E2E do orquestrador: mocka o transporte (segfy.api) e o scraper, exercitando
 * processarFormularioAuto ponta a ponta contra uma persistência em memória.
 * Valida: fluxo completo, separação cotacao_id vs segurado_id, fallback de
 * token (API falha -> scraper -> retry), e guard de LGPD.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const estado = vi.hoisted(() => ({ falharSeguradoUmaVez: false }));

vi.mock("../src/integrations/segfy/segfy.scraper", () => ({
  iniciarSessaoSegfy: vi.fn(async () => ({})),
  encerrarSessaoSegfy: vi.fn(async () => undefined),
}));

vi.mock("../src/integrations/segfy/segfy.api", () => ({
  segfyAPI: vi.fn(async (method: string, endpoint: string) => {
    if (method === "GET" && endpoint.startsWith("/segurados")) return []; // não existe pelo CPF
    if (method === "POST" && endpoint === "/segurados") {
      if (estado.falharSeguradoUmaVez) {
        estado.falharSeguradoUmaVez = false;
        throw new Error("401 simulado");
      }
      return { id: "seg_1" };
    }
    if (method === "POST" && endpoint === "/cotacoes/auto") return { cotacao_id: "cotseg_1" };
    if (method === "GET" && endpoint.startsWith("/cotacoes/")) {
      return {
        cotacao_id: "cotseg_1",
        status: "concluida",
        resultados: [
          { seguradora: "Porto", premio_total: 2500, parcelas: 10, valor_parcela: 250, coberturas_resumo: "completa", status: "cotado" },
          { seguradora: "Azul", premio_total: 1900, parcelas: 12, valor_parcela: 158.33, coberturas_resumo: "completa", status: "cotado" },
        ],
      };
    }
    throw new Error(`endpoint não mockado: ${method} ${endpoint}`);
  }),
  segfyAPIComRetry: vi.fn(),
}));

import { InMemoryPersistence } from "../src/integrations/segfy/persistence.port";
import { SegfyClient, type DadosFormularioPiero } from "../src/integrations/segfy/segfy.client";
import { iniciarSessaoSegfy } from "../src/integrations/segfy/segfy.scraper";

const dados: DadosFormularioPiero = {
  nome: "Cliente Demo",
  cpf: "00000000000",
  telefone: "+5541999999999",
  cep: "80000000",
  fipe_codigo: "001234-5",
  marca: "VW",
  modelo: "Polo",
  ano_modelo: 2022,
  ano_fabricacao: 2022,
  uso_veiculo: "particular",
  bonus_atual: 5,
};

function novoSetup(consentimento = true) {
  const persistencia = new InMemoryPersistence();
  persistencia.semearCliente({
    id: "cli_1",
    nome: "Cliente Demo",
    cpf: "00000000000",
    email: null,
    telefone: "+5541999999999",
    segfy_id: null,
    consentimento_lgpd: consentimento,
  });
  return { persistencia, client: new SegfyClient(persistencia) };
}

beforeEach(() => {
  estado.falharSeguradoUmaVez = false;
  vi.mocked(iniciarSessaoSegfy).mockClear();
});

describe("SegfyClient.processarFormularioAuto", () => {
  it("executa o fluxo completo e persiste a cotação corretamente", async () => {
    const { persistencia, client } = novoSetup();
    const res = await client.processarFormularioAuto({ conversaId: "conv_1", clienteId: "cli_1", dados });

    expect(res.segurado_id).toBe("seg_1");
    expect(res.cotacao_id).toBe("cotseg_1");
    expect(res.resultados).toHaveLength(2);

    expect(persistencia.cotacoesSalvas).toHaveLength(1);
    const salva = persistencia.cotacoesSalvas[0]!;
    expect(salva.clienteId).toBe("cli_1");
    expect(salva.ramo).toBe("auto");
    // O bug do MD §9 (segurado_id em segfy_cotacao_id) NÃO deve ocorrer:
    expect(salva.segfyCotacaoId).toBe("cotseg_1");
    expect(salva.segfyCotacaoId).not.toBe(res.segurado_id);

    expect(persistencia.logs.some((l) => l.operacao === "cotacao" && l.sucesso)).toBe(true);
  });

  it("usa o fallback do scraper quando a via API falha por auth", async () => {
    estado.falharSeguradoUmaVez = true;
    const { client } = novoSetup();
    const res = await client.processarFormularioAuto({ conversaId: null, clienteId: "cli_1", dados });

    expect(res.segurado_id).toBe("seg_1");
    expect(vi.mocked(iniciarSessaoSegfy)).toHaveBeenCalledTimes(1);
  });

  it("recusa enviar dados ao Segfy sem consentimento LGPD", async () => {
    const { persistencia, client } = novoSetup(false);
    await expect(
      client.processarFormularioAuto({ conversaId: null, clienteId: "cli_1", dados }),
    ).rejects.toThrow(/LGPD/);
    expect(persistencia.cotacoesSalvas).toHaveLength(0);
  });
});
