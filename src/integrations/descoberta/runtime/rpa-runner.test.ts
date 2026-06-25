import { describe, it, expect } from "vitest";
import { executarRpa, validarPassosRpa, moedaBR, assarSeletores, type PaginaRpa } from "./rpa-runner";
import type { PassoRpa } from "../descoberta.types";

function fakePage(): { page: PaginaRpa; acoes: string[] } {
  const acoes: string[] = [];
  const page: PaginaRpa = {
    async navegar(url) {
      acoes.push(`navegar ${url}`);
    },
    async preencher(sel, valor) {
      acoes.push(`preencher ${sel}=${valor.length}ch`);
    },
    async clicar(sel, opts) {
      acoes.push(`clicar ${sel}`);
      return opts?.esperarDownload ? { downloadBytes: 8421 } : undefined;
    },
    async esperarMs() {},
    async esperarSeletor() {},
    async esperarSairDeUrl() {},
    async extrair(sel) {
      // fake: identifica o campo pela substring do seletor/rótulo solicitado
      if (/premio/i.test(sel)) return "R$ 2.480,50";
      if (/lice|mero/i.test(sel)) return "AP-2026-0001";
      return null;
    },
  };
  return { page, acoes };
}

const passosApolice: PassoRpa[] = [
  { tipo: "navegar", url: "https://portal.x.com/login" },
  { tipo: "preencher", seletor: "#user", valor: "{{usuario}}" },
  { tipo: "preencher", seletor: "#pass", valor: "{{senha}}" },
  { tipo: "clicar", seletor: "button[type=submit]" },
  { tipo: "esperar", sairDeUrl: "/login" },
  { tipo: "preencher", seletor: "#busca", valor: "{{proposta}}", descricao: "número da proposta" },
  { tipo: "clicar", seletor: "botao_emitir", papel: true, esperarDownload: true },
  { tipo: "extrair_campo", nome: "numeroApolice", seletorOuRegex: "/ap[oó]lice|n[uú]mero/i" },
  { tipo: "extrair_campo", nome: "premioTotal", seletorOuRegex: "/premio/i", comoMoeda: true },
  { tipo: "extrair_pdf", doDownload: true },
];

describe("moedaBR", () => {
  it("parseia R$ BR", () => {
    expect(moedaBR("R$ 2.480,50")).toBe(2480.5);
    expect(moedaBR("1.234,56")).toBe(1234.56);
  });
});

describe("validarPassosRpa", () => {
  it("rejeita passo fora da whitelist e lista vazia", () => {
    expect(validarPassosRpa(passosApolice).ok).toBe(true);
    expect(validarPassosRpa([{ tipo: "exec" } as never]).ok).toBe(false);
    expect(validarPassosRpa([]).ok).toBe(false);
  });
});

describe("executarRpa (emissão de apólice, fake page)", () => {
  it("executa login→buscar→emitir→extrair PDF e devolve numeroApolice + pdfBytes", async () => {
    const { page, acoes } = fakePage();
    const r = await executarRpa(passosApolice, { usuario: "u", senha: "s", proposta: "PROP-9" }, page, {
      resolverSeletor: async (papel) => (papel === "botao_emitir" ? "button.emitir" : null),
    });
    expect(r.ok).toBe(true);
    expect(r.numeroApolice).toBe("AP-2026-0001");
    expect(r.pdfBytes).toBe(8421);
    expect(r.campos.premioTotal).toBe(2480.5);
    expect(acoes).toContain("clicar button.emitir"); // papel resolvido via LLM
  });

  it("falha se um papel não resolve", async () => {
    const { page } = fakePage();
    const r = await executarRpa([{ tipo: "clicar", seletor: "botao_x", papel: true }], {}, page, { resolverSeletor: async () => null });
    expect(r.ok).toBe(false);
    expect(r.erro).toBe("seletor_nao_resolvido");
  });

  it("retorna seletoresResolvidos (papel→CSS) e assarSeletores assa o spec", async () => {
    const { page } = fakePage();
    const r = await executarRpa(passosApolice, { usuario: "u", senha: "s", proposta: "P" }, page, {
      resolverSeletor: async (papel) => (papel === "botao_emitir" ? "button.emitir" : null),
    });
    expect(r.seletoresResolvidos.botao_emitir).toBe("button.emitir");
    const assado = assarSeletores(passosApolice, r.seletoresResolvidos);
    const emitir = assado.find((p) => p.tipo === "clicar" && (p as { esperarDownload?: boolean }).esperarDownload) as { seletor: string; papel?: boolean };
    expect(emitir.seletor).toBe("button.emitir");
    expect(emitir.papel).toBe(false);
  });
});
