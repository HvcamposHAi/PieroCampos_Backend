import { describe, it, expect } from "vitest";
import { emitirApoliceViaAdapter } from "./apolice.adapter";
import type { PaginaRpa } from "../descoberta/runtime/rpa-runner";
import type { AdapterSpec } from "../descoberta/descoberta.types";
import type { EmitirApoliceContext } from "./apolice-provider.port";

const spec: AdapterSpec = {
  sistema: "exemplo",
  ramo: "auto",
  operacao: "apolice",
  objetivo: "apolice",
  versao: 1,
  entradaObrigatoria: [],
  passos: [],
  passosRpa: [
    { tipo: "navegar", url: "https://portal.x.com/login" },
    { tipo: "preencher", seletor: "#user", valor: "{{usuario}}" },
    { tipo: "preencher", seletor: "#pass", valor: "{{senha}}" },
    { tipo: "clicar", seletor: "button[type=submit]" },
    { tipo: "esperar", sairDeUrl: "/login" },
    { tipo: "preencher", seletor: "#busca", valor: "{{proposta}}" },
    { tipo: "clicar", seletor: "button.emitir", esperarDownload: true },
    { tipo: "extrair_campo", nome: "numeroApolice", seletorOuRegex: "/apolice/i" },
    { tipo: "extrair_campo", nome: "premioTotal", seletorOuRegex: "/premio/i", comoMoeda: true },
    { tipo: "extrair_pdf", doDownload: true },
  ],
};

const ctx: EmitirApoliceContext = {
  corretoraId: "corr1",
  seguradora: { id: "seg1", corretoraId: "corr1", nomeDisplay: "Exemplo", grupoIntegracao: "B_rpa", loginType: null, urlPortal: "https://portal.x.com", urlEmissao: null, vaultKey: null, emailOtp: null, tipoAutenticacao: null },
  proposta: { id: "p1", numeroProposta: "PROP-9", clienteId: "cl1", ramo: "auto", cotacaoId: null },
  credenciais: { usuario: "u", senha: "s" },
};

function fakePage(): PaginaRpa {
  return {
    async navegar() {},
    async preencher() {},
    async clicar(_s, opts) {
      return opts?.esperarDownload ? { downloadBytes: 4096 } : undefined;
    },
    async esperarMs() {},
    async esperarSeletor() {},
    async esperarSairDeUrl() {},
    async extrair(sel) {
      if (/premio/i.test(sel)) return "R$ 1.999,90";
      if (/apolice/i.test(sel)) return "AP-2026-777";
      return null;
    },
    async ultimoPdf() {
      return Buffer.from("%PDF-1.4 fake");
    },
  };
}

describe("emitirApoliceViaAdapter", () => {
  it("roda o adapter validado e devolve numeroApolice + PDF bytes", async () => {
    const r = await emitirApoliceViaAdapter(ctx, spec, fakePage());
    expect(r.sucesso).toBe(true);
    expect(r.numeroApolice).toBe("AP-2026-777");
    expect(r.premioTotal).toBe(1999.9);
    expect(r.pdf?.bytes).toBeInstanceOf(Buffer);
    expect(r.pdf?.contentType).toBe("application/pdf");
  });

  it("sem passosRpa → erro estruturado (não lança)", async () => {
    const r = await emitirApoliceViaAdapter(ctx, { ...spec, passosRpa: [] }, fakePage());
    expect(r.sucesso).toBe(false);
    expect(r.erro).toBe("adapter_sem_passos_rpa");
  });

  it("número não extraído → sucesso=false", async () => {
    const page = fakePage();
    page.extrair = async () => null;
    const r = await emitirApoliceViaAdapter(ctx, spec, page);
    expect(r.sucesso).toBe(false);
    expect(r.erro).toBe("numero_apolice_nao_extraido");
  });
});
