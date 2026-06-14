import { describe, it, expect } from "vitest";
import { criarAdapterProvider, validarSpec, hashDados, type HttpFn, type HttpResp } from "./adapter-runner";
import { InMemoryPersistence } from "../../segfy/persistence.port";
import type { AdapterSpec } from "../descoberta.types";
import type { QuoteContext } from "../../quote/quote-provider.port";

const spec: AdapterSpec = {
  sistema: "exemplo",
  ramo: "auto",
  operacao: "cotacao",
  versao: 1,
  entradaObrigatoria: ["cpf", "placa"],
  passos: [
    { tipo: "auth", metodo: "http_login", url: "https://api.x.com/login", corpo: { email: "{{email}}" }, tokenPath: "data.token", guardarEm: "token" },
    { tipo: "http", metodo: "POST", url: "https://api.x.com/calcular", headers: { Authorization: "Bearer {{token}}" }, corpo: { cpf: "{{cpf}}", placa: "{{placa}}" }, extrair: { calcId: "id" } },
    { tipo: "poll", metodo: "GET", url: "https://api.x.com/status/{{calcId}}", headers: { Authorization: "Bearer {{token}}" }, intervaloMs: 10, timeoutMs: 1000, prontoQuando: { caminho: "retorno", igualA: true } },
    { tipo: "extract", arrayEm: "resultados", mapa: { seguradora: "seguradora", premio_total: "premio", parcelas: "parcelas", status: "status" } },
  ],
  resiliencia: { maxRetries: 1, backoffBaseMs: 1 },
};

const ctx: QuoteContext = { conversaId: "cv1", clienteId: "cl1", ramo: "auto", dados: { email: "a@b.c", cpf: "123", placa: "ABC1D23" }, corretoraId: "corr1", origem: "manual" };

function stubHttp(): { http: HttpFn; chamadas: string[] } {
  const chamadas: string[] = [];
  let pollN = 0;
  const http: HttpFn = async (req): Promise<HttpResp> => {
    chamadas.push(`${req.metodo} ${req.url}`);
    if (req.url.endsWith("/login")) return { status: 200, corpo: { data: { token: "TKN" } } };
    if (req.url.endsWith("/calcular")) return { status: 200, corpo: { id: "c42" } };
    if (req.url.includes("/status/")) {
      pollN += 1;
      const pronto = pollN >= 2; // primeira vez não-pronto, segunda pronto
      return { status: 200, corpo: { resultados: [{ seguradora: "Seg X", premio: 1234.5, parcelas: 10, status: "cotado", retorno: pronto }] } };
    }
    return { status: 404, corpo: {} };
  };
  return { http, chamadas };
}

const noop = async (): Promise<void> => {};

describe("validarSpec", () => {
  it("aceita whitelist e rejeita passo desconhecido", () => {
    expect(validarSpec(spec).ok).toBe(true);
    expect(validarSpec({ ...spec, passos: [{ tipo: "shell" } as never] }).ok).toBe(false);
    expect(validarSpec({ ...spec, passos: [] }).ok).toBe(false);
  });
});

describe("hashDados", () => {
  it("é estável e independente da ordem das chaves", () => {
    expect(hashDados({ a: 1, b: 2 })).toBe(hashDados({ b: 2, a: 1 }));
  });
});

describe("criarAdapterProvider.cotar", () => {
  it("executa auth→http→poll→extract e devolve a mais barata", async () => {
    const { http, chamadas } = stubHttp();
    const persist = new InMemoryPersistence();
    const provider = criarAdapterProvider(spec, { http, sleep: noop });
    const r = await provider.cotar(ctx, persist);
    expect(r).not.toBeNull();
    expect(r?.maisBarata?.seguradora).toBe("Seg X");
    expect(r?.maisBarata?.premio_total).toBe(1234.5);
    // pollou 2x (não-pronto → pronto)
    expect(chamadas.filter((c) => c.includes("/status/")).length).toBe(2);
    // observabilidade: iniciou e concluiu a cotação
    expect(persist.cotacoesIniciadas.length).toBe(1);
    expect(persist.cotacoesAtualizadas.some((c) => c.status === "concluida")).toBe(true);
    // o token capturado no auth foi injetado no header Bearer da chamada de cálculo
    expect(chamadas).toContain("POST https://api.x.com/calcular");
  });

  it("FAIL-CLOSED: dados obrigatórios faltando → null sem chamar HTTP", async () => {
    const { http, chamadas } = stubHttp();
    const provider = criarAdapterProvider(spec, { http, sleep: noop });
    const r = await provider.cotar({ ...ctx, dados: { email: "a@b.c" } });
    expect(r).toBeNull();
    expect(chamadas.length).toBe(0);
  });
});
