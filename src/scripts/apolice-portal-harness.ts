/**
 * Arnês para AUTORAR drivers de portal de seguradora. Abre o navegador (headful),
 * loga com a credencial CIFRADA guardada no banco, navega ao portal de emissão e
 * PARA no Playwright Inspector — onde você inspeciona o DOM e copia os seletores
 * reais (busca de proposta, botão emitir, campos da apólice) para criar o
 * `<seguradora>.driver.ts`. Também salva HTML + screenshot em c:/tmp como apoio.
 *
 * É o caminho honesto: drivers de portal NÃO podem ser escritos às cegas — cada
 * portal tem layout próprio. Rode local (precisa de display); NUNCA no Render/CI.
 *
 * Uso (PowerShell), com o .env do backend (Supabase + WA_AUTH_ENCRYPTION_KEY):
 *   npx tsx src/scripts/apolice-portal-harness.ts "HDI Seguros" [corretoraId]
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { SupabasePersistence } from "../integrations/persistence/supabase-persistence";
import { rowParaRef } from "../services/seguradoras-config.service";
import { obterCredenciaisPortal } from "../services/seguradora-credenciais.service";
import { resolverDriver } from "../integrations/apolice/portais";
import { preencherLoginPadrao } from "../integrations/apolice/portais/driver.port";
import { CORRETORA_SEED_ID } from "../integrations/persistence/supabase-persistence";
import { logger } from "../utils/logger";

async function main(): Promise<void> {
  const nome = process.argv[2];
  const corretoraId = process.argv[3] ?? process.env.CORRETORA_SEED_ID ?? CORRETORA_SEED_ID;
  if (!nome) {
    logger.error('[harness] uso: tsx apolice-portal-harness.ts "<nome_display>" [corretoraId]');
    process.exit(1);
  }

  const persist = new SupabasePersistence(undefined, corretoraId);
  const row = await persist.buscarSeguradoraConfigPorNome(nome);
  if (!row) throw new Error(`seguradora "${nome}" não encontrada no catálogo desta corretora`);
  const ref = rowParaRef(row, corretoraId);
  const cred = await obterCredenciaisPortal({ seguradoraConfigId: ref.id, corretoraId });
  if (!cred) throw new Error(`sem credencial cadastrada p/ "${nome}" (rode o loader / botão Senha)`);

  const driver = resolverDriver(ref);
  const loginUrl = driver.loginUrl ?? ref.urlPortal;
  if (!loginUrl) throw new Error(`"${nome}" sem url_portal`);

  logger.info("[harness] abrindo portal (headful)", { nome, driver: driver.nome });
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  await page.goto(loginUrl, { waitUntil: "networkidle" }).catch(() => undefined);
  await preencherLoginPadrao(page, driver.seletores, cred).catch(() => undefined);
  await page.locator(driver.seletores.submit).first().click({ timeout: 8_000 }).catch(() => undefined);
  // Não preenche OTP aqui — se aparecer, digite manualmente na janela.

  if (ref.urlEmissao && ref.urlEmissao !== loginUrl) {
    await page.waitForTimeout(3_000);
    await page.goto(ref.urlEmissao, { waitUntil: "networkidle" }).catch(() => undefined);
  }

  // Apoio: salva HTML + screenshot do estado atual.
  try {
    const html = await page.content();
    writeFileSync(`c:/tmp/portal-${ref.id}.html`, html, "utf8");
    await page.screenshot({ path: `c:/tmp/portal-${ref.id}.png`, fullPage: true });
    logger.info("[harness] HTML+screenshot salvos em c:/tmp", { id: ref.id });
  } catch {
    /* apoio best-effort */
  }

  logger.info("[harness] PARANDO no Inspector — inspecione o DOM e monte o driver. Feche para encerrar.");
  await page.pause(); // abre o Playwright Inspector

  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}

main().catch((e) => {
  logger.error("[harness] erro", { erro: (e as Error).message });
  process.exit(1);
});
