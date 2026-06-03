/**
 * Funções PURAS da feature "cliente recorrente" (reaproveitar dados + revisar de
 * uma vez): resumo de revisão, bloco do system prompt, gate emRevisao e a decisão
 * de reabertura. Sem rede.
 */
import { describe, it, expect } from "vitest";
import { montarResumoRevisao } from "../src/lib/roteiros";
import { buildSystemPromptDinamico } from "../src/lib/system-prompt";
import { emRevisao } from "../src/services/bot.service";
import { temDadosReaproveitaveis, deveReabrirEmRevisao } from "../src/integrations/whatsapp/persistence";

describe("montarResumoRevisao", () => {
  it("lista só os campos do roteiro preenchidos, com rótulos", () => {
    const linhas = montarResumoRevisao("seguro_novo", {
      segurado: "João Silva",
      email: "joao@x.com",
      placa: "", // vazio → fora
      endereco: { rua: "X" }, // chave fora do roteiro → fora
    });
    expect(linhas).toContain("- Segurado: João Silva");
    expect(linhas).toContain("- E-mail: joao@x.com");
    expect(linhas.some((l) => l.includes("Placa"))).toBe(false);
    expect(linhas.some((l) => l.toLowerCase().includes("endereco"))).toBe(false);
  });

  it("vazio para categoria sem roteiro (duvida/outro)", () => {
    expect(montarResumoRevisao("duvida", { segurado: "X" })).toEqual([]);
    expect(montarResumoRevisao(null, { segurado: "X" })).toEqual([]);
  });

  it("respeita campos excluídos da linha (Admin > Bia)", () => {
    const linhas = montarResumoRevisao(
      "seguro_novo",
      { segurado: "Ana", bonus: "5" },
      ["bonus"], // bonus é opcional → pode ser desligado
    );
    expect(linhas).toContain("- Segurado: Ana");
    expect(linhas.some((l) => l.includes("Bônus"))).toBe(false);
  });
});

describe("buildSystemPromptDinamico — gate de revisão", () => {
  const base = {
    categoria: "seguro_novo" as const,
    contextoRAG: "",
    dadosColetados: { segurado: "João Silva", email: "joao@x.com" },
    pendentesObrigatorios: [],
    proximoCampo: null,
  };

  it("apresenta os dados, pede 'mudou' e cita confirmar_revisao; sem PRÓXIMO CAMPO", () => {
    const p = buildSystemPromptDinamico({ ...base, revisaoPendente: true });
    expect(p).toContain("REVISÃO DE DADOS");
    expect(p).toContain("João Silva");
    expect(p.toLowerCase()).toContain("mudou");
    expect(p).toContain("confirmar_revisao");
    expect(p).not.toContain("PRÓXIMO CAMPO A PERGUNTAR");
  });

  it("holding tem prioridade sobre revisão", () => {
    const p = buildSystemPromptDinamico({
      ...base,
      revisaoPendente: true,
      modo: "holding",
      contextoHolding: "MODO DE ATENDIMENTO: equipe cuidando.",
    });
    expect(p).toContain("equipe cuidando");
    expect(p).not.toContain("REVISÃO DE DADOS");
  });

  it("revisão tem prioridade sobre confirmação de cotação", () => {
    const p = buildSystemPromptDinamico({
      ...base,
      revisaoPendente: true,
      pedirConfirmacaoCotacao: true,
    });
    expect(p).toContain("REVISÃO DE DADOS");
    expect(p).not.toContain("COLETA CONCLUÍDA");
  });

  it("sem a flag, comportamento normal (lista próximo campo)", () => {
    const p = buildSystemPromptDinamico({
      ...base,
      dadosColetados: {},
      pendentesObrigatorios: [{ chave: "segurado", rotulo: "Segurado", obrigatorio: true }],
      proximoCampo: { chave: "segurado", rotulo: "Segurado", obrigatorio: true },
    });
    expect(p).not.toContain("REVISÃO DE DADOS");
    expect(p).toContain("PRÓXIMO CAMPO A PERGUNTAR");
  });
});

describe("emRevisao", () => {
  it("true só quando revisao_pendente === true", () => {
    expect(emRevisao({ revisao_pendente: true })).toBe(true);
    expect(emRevisao({ revisao_pendente: false })).toBe(false);
    expect(emRevisao({})).toBe(false);
    expect(emRevisao({ revisao_pendente: "true" })).toBe(false);
  });
});

describe("temDadosReaproveitaveis / deveReabrirEmRevisao", () => {
  it("tem dados: categoria com roteiro + ≥1 campo preenchido", () => {
    expect(temDadosReaproveitaveis({ segurado: "X" }, "seguro_novo")).toBe(true);
    expect(temDadosReaproveitaveis({}, "seguro_novo")).toBe(false);
    expect(temDadosReaproveitaveis({ segurado: "X" }, "duvida")).toBe(false);
    expect(temDadosReaproveitaveis({ foo: "bar" }, "seguro_novo")).toBe(false);
  });

  it("reabre só em estado terminal elegível, com dados e fora de revisão", () => {
    const dados = { segurado: "X" };
    expect(deveReabrirEmRevisao("cotacao_enviada", {}, dados, "seguro_novo")).toBe(true);
    expect(deveReabrirEmRevisao("apolice_emitida", {}, dados, "seguro_novo")).toBe(true);
    // estados em que a equipe trabalha → não reabre
    expect(deveReabrirEmRevisao("aguardando_cotacao", {}, dados, "seguro_novo")).toBe(false);
    expect(deveReabrirEmRevisao("humano_assumiu", {}, dados, "seguro_novo")).toBe(false);
    expect(deveReabrirEmRevisao("bot_ativo", {}, dados, "seguro_novo")).toBe(false);
    // já em revisão → não reabre de novo
    expect(deveReabrirEmRevisao("cotacao_enviada", { revisao_pendente: true }, dados, "seguro_novo")).toBe(false);
    // sem dados → não reabre
    expect(deveReabrirEmRevisao("cotacao_enviada", {}, {}, "seguro_novo")).toBe(false);
  });
});
