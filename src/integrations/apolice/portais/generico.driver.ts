/**
 * Driver GENÉRICO — fallback quando não há driver específico para a seguradora.
 * Usa seletores tolerantes (os mesmos heurísticos do segfy.scraper) e tenta uma
 * navegação "best-effort": procura a proposta por número via busca textual, um
 * botão "emitir", e lê campos por rótulo. NÃO garante sucesso em portal nenhum —
 * é o ponto de partida que cada driver específico sobrescreve. Falhas viram
 * `EmitirApoliceResult.erro` no scraper (nunca lançam silenciosamente PII).
 */
import type { Page, Download } from "playwright";
import type { EmitirApoliceContext } from "../apolice-provider.port";
import type { DadosApoliceExtraidos, PortalDriver } from "./driver.port";
import { resolverSeletor } from "../llm/portal-mapper.service";

const SEL_USUARIO =
  'input[name="usuario"], input[name="email"], input[type="email"], input[type="text"], input:not([type])';
const SEL_SENHA = 'input[name="password"], input[name="senha"], input[type="password"]';
const SEL_SUBMIT = 'button[type="submit"], button:has-text("Entrar"), button:has-text("Acessar")';
const SEL_OTP =
  'input[name="code"], input[name="otp"], input[name="token"], input[autocomplete="one-time-code"], input[inputmode="numeric"]';

/** Converte "R$ 1.234,56" → 1234.56 (pt-BR). Retorna null se não parsear. */
function moedaBR(texto: string | null | undefined): number | null {
  if (!texto) return null;
  const limpo = texto.replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const n = Number(limpo);
  return Number.isFinite(n) ? n : null;
}

async function textoPorRotulo(page: Page, rotulo: RegExp): Promise<string | null> {
  try {
    const loc = page.getByText(rotulo).first();
    if (!(await loc.isVisible({ timeout: 1_500 }).catch(() => false))) return null;
    const parent = loc.locator("xpath=..");
    return (await parent.innerText().catch(() => null))?.trim() ?? null;
  } catch {
    return null;
  }
}

export const genericoDriver: PortalDriver = {
  nome: "generico",
  seletores: { usuario: SEL_USUARIO, senha: SEL_SENHA, submit: SEL_SUBMIT, otp: SEL_OTP },

  async localizarProposta(page: Page, ctx: EmitirApoliceContext): Promise<void> {
    // Se a seguradora tem portal de EMISSÃO distinto do login, navega até ele.
    const urlEmissao = ctx.seguradora.urlEmissao;
    if (urlEmissao && urlEmissao !== ctx.seguradora.urlPortal) {
      await page.goto(urlEmissao, { waitUntil: "networkidle" }).catch(() => undefined);
    }
    const numero = ctx.proposta.numeroProposta;
    if (!numero) return; // sem número não há como localizar — driver específico trata
    // Campo de busca: LLM (se ligado) escolhe o seletor; senão hint tolerante.
    const hintBusca = 'input[type="search"], input[placeholder*="proposta" i], input[name*="busca" i]';
    const selBusca =
      (await resolverSeletor({
        seguradora: ctx.seguradora.nomeDisplay,
        acao: "campo_busca_proposta",
        descricaoAcao: "Campo onde digitar o número da proposta para localizá-la.",
        corretoraId: ctx.corretoraId,
        page,
      })) ?? hintBusca;
    const busca = page.locator(selBusca).first();
    if (await busca.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await busca.fill(numero).catch(() => undefined);
      await page.keyboard.press("Enter").catch(() => undefined);
    }
    const link = page.getByText(numero, { exact: false }).first();
    await link.click({ timeout: 5_000 }).catch(() => undefined);
  },

  async emitir(page: Page, ctx: EmitirApoliceContext): Promise<Download | null> {
    // Botão "emitir": LLM (se ligado) escolhe o seletor; senão hint tolerante.
    const selEmitir = await resolverSeletor({
      seguradora: ctx.seguradora.nomeDisplay,
      acao: "botao_emitir",
      descricaoAcao: "Botão que emite/gera a apólice (finaliza a emissão).",
      corretoraId: ctx.corretoraId,
      page,
    });
    const botao = selEmitir
      ? page.locator(selEmitir).first()
      : page.getByRole("button", { name: /emitir|gerar ap[oó]lice|finalizar/i }).first();
    const espera = page.waitForEvent("download", { timeout: 30_000 }).catch(() => null);
    await botao.click({ timeout: 8_000 }).catch(() => undefined);
    return espera;
  },

  async extrair(page: Page, _ctx: EmitirApoliceContext): Promise<DadosApoliceExtraidos> {
    const numeroApolice =
      (await textoPorRotulo(page, /ap[oó]lice|n[uú]mero/i))?.replace(/\D+/g, "") || null;
    const premioTotal = moedaBR(await textoPorRotulo(page, /pr[eê]mio total|total/i));
    const premioLiquido = moedaBR(await textoPorRotulo(page, /pr[eê]mio l[ií]quido|l[ií]quido/i));
    return { numeroApolice, inicioVigencia: null, fimVigencia: null, premioTotal, premioLiquido };
  },
};
