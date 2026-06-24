import { describe, it, expect } from "vitest";
import { gerarSpecInicial } from "./spec-template";
import { validarPassosRpa } from "../runtime/rpa-runner";

describe("gerarSpecInicial", () => {
  it("apólice: gera passos papel-based com login→buscar→emitir→extrair e entrada obrigatória", () => {
    const spec = gerarSpecInicial({ sistema: "porto", seguradoraConfigId: "seg-1", ramo: "auto", objetivo: "apolice", urlPortal: "https://portal.porto.com/login" });
    expect(spec.objetivo).toBe("apolice");
    expect(spec.operacao).toBe("apolice");
    expect(spec.seguradoraConfigId).toBe("seg-1");
    expect(spec.entradaObrigatoria).toEqual(["usuario", "senha", "proposta"]);
    expect(validarPassosRpa(spec.passosRpa ?? []).ok).toBe(true);
    // o emitir é único e dispara download
    const emitir = (spec.passosRpa ?? []).filter((p) => p.tipo === "clicar" && (p as { seletor: string }).seletor === "botao_emitir");
    expect(emitir).toHaveLength(1);
    expect((emitir[0] as { esperarDownload?: boolean }).esperarDownload).toBe(true);
    // tem extração de PDF
    expect((spec.passosRpa ?? []).some((p) => p.tipo === "extrair_pdf")).toBe(true);
  });

  it("validar_estrutura: só navega (portão)", () => {
    const spec = gerarSpecInicial({ sistema: "x", seguradoraConfigId: "s", ramo: "auto", objetivo: "validar_estrutura", urlPortal: "https://x.com" });
    expect(spec.passosRpa).toEqual([{ tipo: "navegar", url: "https://x.com" }]);
  });

  it("cotação: sem passos RPA (usa pipeline HTTP)", () => {
    const spec = gerarSpecInicial({ sistema: "x", seguradoraConfigId: "s", ramo: "auto", objetivo: "cotacao", urlPortal: null });
    expect(spec.passosRpa).toEqual([]);
    expect(spec.operacao).toBe("cotacao");
  });
});
