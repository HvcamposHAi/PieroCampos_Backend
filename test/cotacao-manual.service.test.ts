/**
 * Unit: cotação manual (operador). Cobre find-or-create de cliente por CPF e o
 * disparo (conversaId nulo + origem 'manual' + sem envio ao WhatsApp). Sem rede:
 * o Supabase admin e o pipeline Segfy são mockados.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const results: Array<{ data: unknown; error: unknown }> = [];
  const calls = { from: [] as string[], insert: [] as unknown[], update: [] as unknown[] };
  function builder() {
    const result = results.length ? results.shift()! : { data: null, error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    const ret = (): unknown => b;
    b.select = vi.fn(ret);
    b.eq = vi.fn(ret);
    b.is = vi.fn(ret);
    b.limit = vi.fn(ret);
    b.maybeSingle = vi.fn(ret);
    b.single = vi.fn(ret);
    b.insert = vi.fn((v: unknown) => (calls.insert.push(v), b));
    b.update = vi.fn((v: unknown) => (calls.update.push(v), b));
    b.then = (resolve: (v: unknown) => void): void => resolve(result);
    return b;
  }
  const sb = { from: vi.fn((t: string) => (calls.from.push(t), builder())) };
  return { results, calls, sb, disparar: vi.fn() };
});

vi.mock("../src/integrations/whatsapp/supabase", () => ({ getSupabaseAdmin: () => h.sb }));
vi.mock("../src/services/segfy-cotacao.service", () => ({ dispararCotacaoSegfy: h.disparar }));

import {
  criarOuObterClientePorCpf,
  dispararCotacaoManual,
} from "../src/services/cotacao-manual.service";

const CPF_VALIDO = "090.656.619-30"; // dígitos: 09065661930
const CLIENTE = { nome: "Maria Teste", telefone: "+5541999990000", cpf: CPF_VALIDO, email: "m@x.com" };

beforeEach(() => {
  h.results.length = 0;
  h.calls.from.length = 0;
  h.calls.insert.length = 0;
  h.calls.update.length = 0;
  h.sb.from.mockClear();
  h.disparar.mockReset();
});

describe("criarOuObterClientePorCpf", () => {
  it("REUSA cliente existente (CPF) com consentimento — não insere nem atualiza", async () => {
    h.results.push({ data: { id: "cli-1", consentimento_lgpd: true }, error: null });
    const id = await criarOuObterClientePorCpf(CLIENTE);
    expect(id).toBe("cli-1");
    expect(h.calls.from).toEqual(["clientes"]);
    expect(h.calls.insert).toHaveLength(0);
    expect(h.calls.update).toHaveLength(0);
  });

  it("REUSA mas GARANTE consentimento quando faltava (update)", async () => {
    h.results.push({ data: { id: "cli-2", consentimento_lgpd: false }, error: null });
    h.results.push({ data: null, error: null }); // update().eq()
    const id = await criarOuObterClientePorCpf(CLIENTE);
    expect(id).toBe("cli-2");
    expect(h.calls.insert).toHaveLength(0);
    expect(h.calls.update).toHaveLength(1);
    expect(h.calls.update[0]).toMatchObject({ consentimento_lgpd: true });
  });

  it("CRIA cliente quando não existe — CPF em dígitos e consentimento true", async () => {
    h.results.push({ data: null, error: null }); // select → nada
    h.results.push({ data: { id: "cli-new" }, error: null }); // insert → id
    const id = await criarOuObterClientePorCpf(CLIENTE);
    expect(id).toBe("cli-new");
    expect(h.calls.insert).toHaveLength(1);
    expect(h.calls.insert[0]).toMatchObject({
      cpf: "09065661930",
      telefone: "+5541999990000",
      consentimento_lgpd: true,
    });
  });
});

describe("dispararCotacaoManual", () => {
  it("dispara com conversaId NULL + origem 'manual', sem callback de envio, e devolve o cotacaoId", async () => {
    h.results.push({ data: { id: "cli-1", consentimento_lgpd: true }, error: null });
    h.disparar.mockImplementation(
      async (_p: unknown, _persist: unknown, onIniciada?: (id: string) => void) => {
        onIniciada?.("cot_9");
        return null;
      },
    );

    const r = await dispararCotacaoManual({
      cliente: CLIENTE,
      dados: { cpf: CPF_VALIDO, placa: "ABC1D23", cep: "80000000" },
    });

    expect(r).toEqual({ clienteId: "cli-1", cotacaoId: "cot_9" });
    expect(h.disparar).toHaveBeenCalledTimes(1);
    const args = h.disparar.mock.calls[0]!;
    expect(args[0]).toMatchObject({ conversaId: null, clienteId: "cli-1", origem: "manual" });
    // 3º argumento é o onIniciada; NÃO há callback `enviar` (nada vai ao WhatsApp).
    expect(typeof args[2]).toBe("function");
  });

  it("propaga erro se a cotação nunca for criada (onIniciada não chamado)", async () => {
    h.results.push({ data: { id: "cli-1", consentimento_lgpd: true }, error: null });
    h.disparar.mockRejectedValue(new Error("iniciarCotacao falhou"));
    await expect(
      dispararCotacaoManual({ cliente: CLIENTE, dados: { placa: "ABC1D23", cep: "80000000" } }),
    ).rejects.toThrow("iniciarCotacao falhou");
  });
});
