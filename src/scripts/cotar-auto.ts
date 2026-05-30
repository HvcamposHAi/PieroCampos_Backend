/**
 * Cotação Auto AUTOMÁTICA pelo sistema (demo/CLI). Login 100% HTTP (sem browser)
 * e roda o fluxo LIVE de ponta a ponta — imprime o comparativo do WhatsApp.
 *
 * 1 cotação:  npm run segfy:cotar -- <cpf> <placa> <cep> [profissao]
 * N cotações: npm run segfy:cotar -- <cpf1>:<placa1>:<cep1> <cpf2>:<placa2>:<cep2> ...
 * Ex.:  npm run segfy:cotar -- 09065661930 SFI7F72 81270320 Administrador
 */
import { obterTokensSegfy, cotarAuto } from "../integrations/segfy/segfy.multicalculo";
import { formatarComparativoParaWhatsApp } from "../integrations/segfy/segfy.format";
import { logger } from "../utils/logger";

interface Pedido { cpf: string; placa: string; cep: string; profissao?: string }

function parsePedidos(args: string[]): Pedido[] {
  // Modo lote: cada arg "cpf:placa:cep[:profissao]"
  if (args.some((a) => a.includes(":"))) {
    return args.map((a) => {
      const [cpf, placa, cep, profissao] = a.split(":");
      return { cpf: cpf ?? "", placa: placa ?? "", cep: cep ?? "", profissao };
    });
  }
  // Modo simples: <cpf> <placa> <cep> [profissao]
  const [cpf, placa, cep, profissao] = args;
  return [{ cpf: cpf ?? "", placa: placa ?? "", cep: cep ?? "", profissao }];
}

async function main(): Promise<void> {
  const pedidos = parsePedidos(process.argv.slice(2));
  if (pedidos.some((p) => !p.cpf || !p.placa || !p.cep)) {
    console.error("Uso: npm run segfy:cotar -- <cpf> <placa> <cep> [profissao]");
    console.error("Lote: npm run segfy:cotar -- <cpf:placa:cep> <cpf:placa:cep> ...");
    process.exit(1);
  }

  // Login UMA vez (cacheado); todas as cotações reusam o mesmo token.
  logger.info("Login (HTTP, sem browser)...");
  const tokens = await obterTokensSegfy();

  for (const [i, p] of pedidos.entries()) {
    logger.info(`Cotando ${i + 1}/${pedidos.length}`, { placa: p.placa });
    const resultados = await cotarAuto(p, tokens);
    console.log(`\n=== Cotação ${i + 1}: ${p.placa} — ${resultados.length} seguradoras ===`);
    for (const r of resultados) {
      const linha = r.status === "cotado"
        ? `R$ ${r.premio_total.toFixed(2)} (${r.parcelas}x R$ ${r.valor_parcela.toFixed(2)})`
        : `[${r.status}]`;
      console.log(`  ${r.seguradora}: ${linha}`);
    }
    console.log("--- Comparativo (WhatsApp) ---");
    console.log(formatarComparativoParaWhatsApp(resultados, "cliente"));
  }
}

void main().catch((e) => {
  logger.error("cotar-auto falhou", { erro: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
