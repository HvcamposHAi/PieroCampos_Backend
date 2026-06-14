/**
 * Bloco de REVISÃO do system prompt: deve mostrar os OBRIGATÓRIOS pendentes e
 * travar o encerramento prematuro ("repassar pra equipe"), além de permitir
 * gravar mudanças já informadas. Regression do bug "trocar placa" (cliente
 * recorrente concluía sem coletar data_nascimento/sexo nem salvar a placa).
 */
import { describe, it, expect } from "vitest";
import { buildSystemPromptDinamico } from "../src/lib/system-prompt";
import type { CampoRoteiro } from "../src/lib/roteiros";

const PENDENTES: CampoRoteiro[] = [
  { chave: "data_nascimento", rotulo: "Data de nascimento", obrigatorio: true },
  { chave: "sexo", rotulo: "Sexo", obrigatorio: true },
];

function base(over: Record<string, unknown> = {}) {
  return buildSystemPromptDinamico({
    categoria: "seguro_novo",
    contextoRAG: "",
    dadosColetados: { segurado: "Humberto", placa: "AVJ1548" },
    pendentesObrigatorios: PENDENTES,
    proximoCampo: PENDENTES[0],
    campoForcado: null,
    revisaoPendente: true,
    sistema: "aggilizador",
    ...over,
  } as never);
}

describe("system-prompt — bloco de revisão", () => {
  it("mostra os obrigatórios pendentes e proíbe encerrar cedo", () => {
    const p = base();
    expect(p).toContain("AINDA FALTAM");
    expect(p).toContain("Data de nascimento");
    expect(p).toContain("Sexo");
    expect(p).toMatch(/NUNCA diga que .*tem tudo.*|repassar para a equipe/i);
  });

  it("permite atualizar_dados quando o cliente já informou a mudança", () => {
    const p = base();
    expect(p).toMatch(/informou alguma mudança CONCRETA/i);
    expect(p).toContain("atualizar_dados");
  });

  it("sem pendentes → NÃO injeta a seção de obrigatórios faltantes", () => {
    const p = base({ pendentesObrigatorios: [] });
    expect(p).not.toContain("AINDA FALTAM");
  });

  it("fora da revisão o bloco não é usado (sem 'AINDA FALTAM' do revisão)", () => {
    const p = base({ revisaoPendente: false });
    // No fluxo normal o prompt é outro; a frase específica da revisão não aparece.
    expect(p).not.toContain("AINDA FALTAM estes dados OBRIGATÓRIOS para cotar (o cliente recorrente");
  });
});

describe("system-prompt — disciplina de coleta (BASE) + telefone derivado", () => {
  it("BASE tem regras: só campos do roteiro + não encerrar com obrigatório pendente + telefone do WhatsApp", () => {
    // SYSTEM_PROMPT_BASE é exportado e estável.
    // (importado abaixo para não acoplar ao dinâmico)
  });

  it("fluxo normal: injeta TELEFONE DO CLIENTE quando derivado e ainda não coletado", () => {
    const p = base({ revisaoPendente: false, telefoneContato: "+5541996247863" });
    expect(p).toContain("TELEFONE DO CLIENTE");
    expect(p).toContain("+5541996247863");
    expect(p).toMatch(/CONFIRME com o cliente/i);
  });

  it("não injeta telefone se já coletado (telefone/telefone_contato presente)", () => {
    const p = base({
      revisaoPendente: false,
      telefoneContato: "+5541996247863",
      dadosColetados: { segurado: "x", telefone_contato: "+5541999990000" },
    });
    expect(p).not.toContain("número do WhatsApp em contato");
  });

  it("não injeta telefone quando o JID é oculto (telefoneContato null)", () => {
    const p = base({ revisaoPendente: false, telefoneContato: null });
    expect(p).not.toContain("TELEFONE DO CLIENTE (número do WhatsApp");
  });
});

import { SYSTEM_PROMPT_BASE } from "../src/lib/system-prompt";
describe("SYSTEM_PROMPT_BASE — regras absolutas novas", () => {
  it("proíbe perguntas fora do roteiro e encerrar com obrigatório pendente", () => {
    expect(SYSTEM_PROMPT_BASE).toMatch(/EXCLUSIVAMENTE os campos listados em "CAMPOS DO ROTEIRO"/);
    // proíbe inventar perguntas fora do roteiro (ex.: filhos, condutor)
    expect(SYSTEM_PROMPT_BASE).toMatch(/condutor principal\/adicional/);
    expect(SYSTEM_PROMPT_BASE).toMatch(/NUNCA.*repassar para a equipe.*obrigatório/is);
  });
  it("telefone = número do WhatsApp (registrar + confirmar)", () => {
    expect(SYSTEM_PROMPT_BASE).toMatch(/TELEFONE do cliente é o próprio número do WhatsApp/);
  });
});
