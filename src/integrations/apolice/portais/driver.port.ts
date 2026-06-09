/**
 * Contrato de um DRIVER de portal de seguradora. Cada portal (Porto, HDI, …) tem
 * layout próprio, então a navegação específica (localizar a proposta, clicar em
 * "emitir", baixar o PDF, ler número/vigência/prêmio) vive num driver dedicado.
 * O `apolice.scraper.ts` cuida do que é COMUM (subir o Chromium, login, OTP) e
 * delega ao driver os passos específicos. Seletores são TOLERANTES (a SPA muda).
 *
 * Driver é PURO sobre a Page do Playwright — sem Supabase, sem env.
 */
import type { Page, Download } from "playwright";
import type { CredenciaisPortal, EmitirApoliceContext } from "../apolice-provider.port";

export interface SeletoresLogin {
  /** Seletor tolerante do campo de usuário/e-mail. */
  usuario: string;
  senha: string;
  submit: string;
  /** Desafio de OTP (grupo C_otp) — ausente nos portais B_rpa. */
  otp?: string;
  /** Banner de cookies a dispensar antes do submit (opcional). */
  cookiesOk?: string;
}

export interface DadosApoliceExtraidos {
  numeroApolice: string | null;
  inicioVigencia: string | null;
  fimVigencia: string | null;
  premioTotal: number | null;
  premioLiquido: number | null;
}

export interface PortalDriver {
  /** Casa com `seguradoras_config.nome_display` (case-insensitive) ou serve de genérico. */
  readonly nome: string;
  /** URL de login do portal. Se ausente, usa `seguradora.urlPortal` do contexto. */
  readonly loginUrl?: string;
  readonly seletores: SeletoresLogin;
  /** Navega até a proposta aprovada (por número) e abre a tela de emissão. */
  localizarProposta(page: Page, ctx: EmitirApoliceContext): Promise<void>;
  /** Dispara a emissão e devolve o evento de download do PDF (ou null se não baixar). */
  emitir(page: Page, ctx: EmitirApoliceContext): Promise<Download | null>;
  /** Lê os campos da apólice emitida na tela. */
  extrair(page: Page, ctx: EmitirApoliceContext): Promise<DadosApoliceExtraidos>;
}

/** Login padrão tolerante reusável pelos drivers (preenche usuário/senha e submete). */
export async function preencherLoginPadrao(
  page: Page,
  seletores: SeletoresLogin,
  cred: CredenciaisPortal,
): Promise<void> {
  await page.locator(seletores.usuario).first().fill(cred.usuario);
  await page.locator(seletores.senha).first().fill(cred.senha);
}
