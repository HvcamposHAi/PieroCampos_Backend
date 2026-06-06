/**
 * Orquestrador de cotação (multi-ramo). Prova que:
 *  - ramo NÃO-AUTO (vida) cai no provider não-automatizado: cria cotação 'pendente'
 *    com o ramo certo, SEM chamar o Segfy (nenhuma etapa token/calculo).
 *  - ramo AUTO usa o provider Segfy (que, sem SEGFY_ENABLED, falha graciosamente
 *    retornando null e marcando a cotação como erro — comportamento atual).
 * Sem rede: usa InMemoryPersistence.
 */
import { describe, it, expect } from "vitest";
import { dispararCotacao } from "../src/services/cotacao.service";
import { InMemoryPersistence } from "../src/integrations/segfy/persistence.port";

describe("dispararCotacao — orquestrador multi-ramo", () => {
  it("ramo 'vida' → cotação pendente p/ operador, sem Segfy", async () => {
    const mem = new InMemoryPersistence();
    const r = await dispararCotacao(
      {
        conversaId: "conv-vida",
        clienteId: "cli-1",
        dados: { segurado: "Maria", capital_segurado_desejado: "200000" },
        ramo: "vida",
        corretoraId: "corr-1",
      },
      mem,
    );

    // Há um resultado (cotou), mas é não-automatizado (sem comparativo do Segfy).
    expect(r).not.toBeNull();
    expect(r!.maisBarata).toBeNull();
    expect(r!.cotacaoId).toBeTruthy();

    // Cotação criada com ramo vida e marcada como pendente.
    expect(mem.cotacoesIniciadas).toHaveLength(1);
    expect(mem.cotacoesIniciadas[0]!.ramo).toBe("vida");
    expect(mem.cotacoesAtualizadas.some((c) => c.status === "pendente")).toBe(true);

    // NUNCA tocou etapas do Segfy (token/segurado/veiculo/calculo).
    const etapasSegfy = mem.etapas.filter((e) =>
      ["token", "segurado", "veiculo", "calculo"].includes(e.etapa),
    );
    expect(etapasSegfy).toHaveLength(0);
  });

  it("ramo 'auto' sem SEGFY_ENABLED → provider Segfy falha gracioso (null)", async () => {
    const mem = new InMemoryPersistence();
    mem.semearCliente({
      id: "cli-2",
      nome: "Auto",
      cpf: "09065661930",
      email: null,
      telefone: "+55",
      segfy_id: null,
      consentimento_lgpd: true,
    });
    const r = await dispararCotacao(
      { conversaId: "conv-auto", clienteId: "cli-2", dados: { placa: "ABC1D23", cep: "80000000" }, ramo: "auto" },
      mem,
    );
    // Segfy desabilitado nos testes → retorna null e marca erro (comportamento atual).
    expect(r).toBeNull();
    expect(mem.cotacoesIniciadas[0]!.ramo).toBe("auto");
    expect(mem.cotacoesAtualizadas.some((c) => c.status === "erro")).toBe(true);
  });
});
