/**
 * Orquestrador dispararCotacaoAggilizador (espelha segfy-cotacao.test):
 *  - AGGILIZADOR_ENABLED=false → não cota, mas deixa rastro (cotação + etapa erro).
 *  - habilitado + cotarAuto mockado → conclui, persiste resultados e formata texto.
 * Sem rede: InMemoryPersistence + mock do cotarAuto e das credenciais.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const cotarMock = vi.fn();
vi.mock("../src/integrations/aggilizador/aggilizador.multicalculo", () => ({
  cotarAutoAggilizador: (...args: unknown[]) => cotarMock(...args),
}));
vi.mock("../src/services/segfy-credenciais.service", () => ({
  obterCredenciaisSegfy: vi.fn(async () => ({ email: "karla@sul.com.br", password: "pw", fonte: "db" })),
}));

import { dispararCotacaoAggilizador } from "../src/services/aggilizador-cotacao.service";
import { InMemoryPersistence } from "../src/integrations/segfy/persistence.port";
import { _resetEnvCache } from "../src/config/env";

function semearCliente(mem: InMemoryPersistence, consentimento = true) {
  mem.semearCliente({
    id: "cli1",
    nome: "Camilly",
    cpf: "09065661930",
    email: "c@x.com",
    telefone: "+5541999990000",
    segfy_id: null,
    consentimento_lgpd: consentimento,
  });
}

const DADOS = { cpf: "09065661930", placa: "SFI7F72", cep: "81270320", sexo: "feminino", data_nascimento: "1980-11-03" };

beforeEach(() => {
  cotarMock.mockReset();
  process.env.WA_ENABLED = "false";
  process.env.BIA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "false";
  process.env.AGGILIZADOR_ENABLED = "false";
  _resetEnvCache();
});

describe("dispararCotacaoAggilizador", () => {
  it("AGGILIZADOR_ENABLED=false: não cota, mas deixa rastro (etapa de erro)", async () => {
    const mem = new InMemoryPersistence();
    semearCliente(mem);
    const r = await dispararCotacaoAggilizador({ conversaId: "c1", clienteId: "cli1", dados: DADOS }, mem);
    expect(r).toBeNull();
    expect(mem.cotacoesIniciadas).toHaveLength(1);
    expect(mem.cotacoesAtualizadas.some((c) => c.status === "erro")).toBe(true);
    expect(mem.etapas.find((e) => e.status === "erro")?.mensagem).toMatch(/desabilitada/i);
    expect(cotarMock).not.toHaveBeenCalled();
  });

  it("habilitado + cotarAuto mockado → conclui, persiste e formata comparativo", async () => {
    process.env.AGGILIZADOR_ENABLED = "true";
    _resetEnvCache();
    cotarMock.mockResolvedValue({
      idIntegracao: "agg-123",
      versao: 1,
      resultados: [
        { seguradora: "Aliro", premio_total: 1900, parcelas: 10, valor_parcela: 190, coberturas_resumo: "", status: "cotado" },
        { seguradora: "Sancor", premio_total: 0, parcelas: 1, valor_parcela: 0, coberturas_resumo: "", status: "recusado" },
      ],
    });
    const mem = new InMemoryPersistence();
    semearCliente(mem);
    const r = await dispararCotacaoAggilizador({ conversaId: "c1", clienteId: "cli1", dados: DADOS }, mem);

    expect(cotarMock).toHaveBeenCalledTimes(1);
    expect(r).not.toBeNull();
    expect(r!.maisBarata?.seguradora).toBe("Aliro");
    expect(r!.texto).toMatch(/Aliro/);
    const concluida = mem.cotacoesAtualizadas.find((c) => c.status === "concluida");
    expect(concluida?.segfyCotacaoId).toBe("agg-123");
    expect(mem.etapas.some((e) => e.etapa === "salvar" && e.status === "ok")).toBe(true);
    expect(mem.logs.some((l) => l.operacao === "cotacao" && l.sucesso)).toBe(true);
  });

  it("habilitado mas sem consentimento LGPD → null + etapa de erro", async () => {
    process.env.AGGILIZADOR_ENABLED = "true";
    _resetEnvCache();
    const mem = new InMemoryPersistence();
    semearCliente(mem, false);
    const r = await dispararCotacaoAggilizador({ conversaId: "c1", clienteId: "cli1", dados: DADOS }, mem);
    expect(r).toBeNull();
    expect(mem.etapas.find((e) => e.status === "erro")?.mensagem).toMatch(/LGPD/i);
    expect(cotarMock).not.toHaveBeenCalled();
  });
});
