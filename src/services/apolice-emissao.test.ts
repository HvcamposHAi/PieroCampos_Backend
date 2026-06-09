// E2E in-memory da emissão: proposta 'aprovada' + seguradoras_config + provider
// FAKE → apólice persistida, proposta vira 'emitida', log de sucesso. Prova ainda
// que a emissão NÃO escreve em status_acesso (decisão: só o "Testar" muda status).
import { describe, it, expect } from "vitest";
import { InMemoryPersistence, type SeguradoraConfigRow } from "../integrations/segfy/persistence.port";
import type { ApoliceProvider } from "../integrations/apolice/apolice-provider.port";
import { emitirApolice } from "./apolice-emissao.service";

const SEGURADORA = "HDI Seguros";

function configRow(): SeguradoraConfigRow {
  return {
    id: "seg-1",
    nome_display: SEGURADORA,
    ativo: true,
    status_acesso: "ok",
    grupo_integracao: "B_rpa",
    tipo_autenticacao: null,
    login_type: null,
    ramos: ["auto"],
    email_otp: null,
    url_portal: "https://portal.exemplo/login",
    vault_key: null,
    observacao_tecnica: null,
    ultimo_acesso: null,
  };
}

const providerOk: ApoliceProvider = {
  nome: "fake",
  grupo: "B_rpa",
  emitir: async () => ({
    sucesso: true,
    numeroApolice: "AP-999",
    inicioVigencia: "2026-06-09",
    fimVigencia: "2027-06-09",
    premioTotal: 1234.56,
    premioLiquido: 1000,
    pdf: null, // sem PDF → não toca o storage
  }),
};

const credOk = async () => ({ usuario: "u", senha: "p" });

function semearProposta(persist: InMemoryPersistence, status: "aprovada" | "transmitida"): void {
  persist.semearSeguradoraConfig(configRow());
  persist.semearProposta({
    id: "prop-1",
    clienteId: "cli-1",
    cotacaoId: "cot-1",
    ramo: "auto",
    seguradora: SEGURADORA,
    status,
    numeroProposta: "123",
  });
}

describe("emitirApolice (E2E in-memory)", () => {
  it("proposta aprovada → emite, persiste apólice e marca 'emitida' (sem mexer em status_acesso)", async () => {
    const persist = new InMemoryPersistence();
    semearProposta(persist, "aprovada");

    const r = await emitirApolice(
      { propostaId: "prop-1", corretoraId: "c1" },
      { persist, provider: providerOk, resolverCredenciais: credOk },
    );

    expect("apoliceId" in r).toBe(true);
    expect(persist.apolicesSalvas).toHaveLength(1);
    const apo = persist.apolicesSalvas[0]!;
    expect(apo.numeroApolice).toBe("AP-999");
    expect(apo.premioTotal).toBe(1234.56);
    expect(apo.propostaId).toBe("prop-1");

    // Proposta transicionou para 'emitida'.
    expect(persist.propostasAtualizadas.some((p) => p.status === "emitida")).toBe(true);

    // Log de auditoria de sucesso da operação 'apolice'.
    expect(persist.logs.some((l) => l.operacao === "apolice" && l.sucesso)).toBe(true);

    // Decisão de produto: emissão NUNCA mexe no status de acesso da seguradora.
    expect(persist.statusAcessoRegistrado).toHaveLength(0);
  });

  it("proposta não-aprovada → recusa com erro, sem persistir apólice", async () => {
    const persist = new InMemoryPersistence();
    semearProposta(persist, "transmitida");

    const r = await emitirApolice(
      { propostaId: "prop-1", corretoraId: "c1" },
      { persist, provider: providerOk, resolverCredenciais: credOk },
    );

    expect(r).toEqual({ erro: "proposta_nao_aprovada" });
    expect(persist.apolicesSalvas).toHaveLength(0);
  });

  it("proposta inexistente (ou de outra corretora) → proposta_nao_encontrada", async () => {
    const persist = new InMemoryPersistence();
    const r = await emitirApolice(
      { propostaId: "nao-existe", corretoraId: "c1" },
      { persist, provider: providerOk, resolverCredenciais: credOk },
    );
    expect(r).toEqual({ erro: "proposta_nao_encontrada" });
    expect(persist.apolicesSalvas).toHaveLength(0);
  });

  it("ciclo completo: proposta criada (transmitida) → aprovada → emitida", async () => {
    const persist = new InMemoryPersistence();
    persist.semearSeguradoraConfig(configRow());

    // 1) Operador cria a proposta a partir da cotação (nasce 'transmitida').
    const { propostaId } = await persist.salvarProposta({
      clienteId: "cli-1",
      cotacaoId: "cot-1",
      seguradora: SEGURADORA,
      numeroProposta: "123",
    });
    expect((await persist.buscarProposta(propostaId))?.status).toBe("transmitida");

    // Emissão antes de aprovar é recusada.
    const cedo = await emitirApolice(
      { propostaId, corretoraId: "c1" },
      { persist, provider: providerOk, resolverCredenciais: credOk },
    );
    expect(cedo).toEqual({ erro: "proposta_nao_aprovada" });

    // 2) Proposta é aprovada.
    await persist.atualizarPropostaStatus(propostaId, { status: "aprovada" });
    expect((await persist.buscarProposta(propostaId))?.status).toBe("aprovada");

    // 3) Emissão agora persiste a apólice e fecha o ciclo em 'emitida'.
    const r = await emitirApolice(
      { propostaId, corretoraId: "c1" },
      { persist, provider: providerOk, resolverCredenciais: credOk },
    );
    expect("apoliceId" in r).toBe(true);
    expect(persist.apolicesSalvas.at(-1)?.propostaId).toBe(propostaId);
    expect((await persist.buscarProposta(propostaId))?.status).toBe("emitida");
  });

  it("sem credencial de portal (B_rpa) → erro sem_credencial, sem emitir", async () => {
    const persist = new InMemoryPersistence();
    semearProposta(persist, "aprovada");
    const r = await emitirApolice(
      { propostaId: "prop-1", corretoraId: "c1" },
      { persist, provider: providerOk, resolverCredenciais: async () => null },
    );
    expect(r).toEqual({ erro: "sem_credencial" });
    expect(persist.apolicesSalvas).toHaveLength(0);
  });
});
