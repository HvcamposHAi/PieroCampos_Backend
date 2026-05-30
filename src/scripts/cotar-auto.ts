/**
 * Cotação Auto AUTOMÁTICA pelo sistema (demo/CLI). Roda o fluxo LIVE de ponta a
 * ponta e imprime o comparativo formatado — sem tocar no navegador/form.
 *
 * Uso:  npm run segfy:cotar -- <cpf> <placa> <cep> [profissao]
 * Ex.:  npm run segfy:cotar -- 09065661930 SFI7F72 81270320 Administrador
 */
import { obterTokensSegfy, cotarAuto } from "../integrations/segfy/segfy.multicalculo";
import { formatarComparativoParaWhatsApp } from "../integrations/segfy/segfy.format";
import { logger } from "../utils/logger";

async function main(): Promise<void> {
  const [cpf, placa, cep, profissao] = process.argv.slice(2);
  if (!cpf || !placa || !cep) {
    console.error("Uso: npm run segfy:cotar -- <cpf> <placa> <cep> [profissao]");
    process.exit(1);
  }

  logger.info("Obtendo tokens (login)...");
  const tokens = await obterTokensSegfy();

  logger.info("Cotando...", { placa });
  const resultados = await cotarAuto({ cpf, placa, cep, profissao }, tokens);

  console.log(`\n=== ${resultados.length} seguradoras ===`);
  for (const r of resultados) {
    const linha = r.status === "cotado"
      ? `R$ ${r.premio_total.toFixed(2)} (${r.parcelas}x R$ ${r.valor_parcela.toFixed(2)})`
      : `[${r.status}]`;
    console.log(`  ${r.seguradora}: ${linha}`);
  }

  console.log("\n=== Comparativo (WhatsApp) ===");
  console.log(formatarComparativoParaWhatsApp(resultados, "cliente"));
}

void main().catch((e) => {
  logger.error("cotar-auto falhou", { erro: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
