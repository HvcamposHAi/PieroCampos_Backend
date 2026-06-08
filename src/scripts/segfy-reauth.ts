/**
 * Validação LOCAL da reautenticação assistida (2FA) do Segfy — Fase 0.
 *
 * Responde à pergunta "o scraping funciona DEPOIS de digitar o código?" sem mexer
 * em produção. Roda o MESMO fluxo do Admin (iniciarReauth → você digita o código
 * no terminal → confirmarReauth), persiste a sessão e então exercita o caminho de
 * cotação (obterTokensSegfy com a sessão restaurada). Imprime ✅/❌.
 *
 * Rode com o navegador VISÍVEL para acompanhar:
 *   SEGFY_HEADLESS=false npm run segfy:reauth
 *
 * .env local necessário (exemplo):
 *   SEGFY_ENABLED=true
 *   SEGFY_SCRAPING_ENABLED=true
 *   SEGFY_HEADLESS=false
 *   WA_ENABLED=false           # não sobe o Baileys neste teste
 *   BIA_ENABLED=false          # não exige ANTHROPIC_API_KEY neste teste
 *   SUPABASE_URL=...           # projeto onde está segfy_credenciais
 *   SUPABASE_SERVICE_ROLE_KEY=...
 *   SUPABASE_ANON_KEY=...
 *   WA_AUTH_ENCRYPTION_KEY=... # mesma chave usada p/ cifrar a sessão
 *   # credenciais do Segfy: cadastradas no Admin (segfy_credenciais) OU SEGFY_LOGIN/SEGFY_SENHA
 *
 * NUNCA loga código/cookie/token/senha.
 */
import readline from "node:readline";
import { obterCredenciaisSegfy } from "../services/segfy-credenciais.service";
import {
  iniciarReauth,
  confirmarReauth,
  statusSessao,
  restaurarSessao,
} from "../services/segfy-sessao.service";
import { obterTokensSegfy } from "../integrations/segfy/segfy.multicalculo";
import { logger } from "../utils/logger";

function pergunta(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a.trim()); }));
}

async function main(): Promise<void> {
  console.log("== Segfy reauth (validação local da Fase 0) ==\n");

  const creds = await obterCredenciaisSegfy();
  if (!creds) throw new Error("Sem credenciais Segfy (cadastre em Admin › Segfy ou .env).");
  console.log(`Credenciais: ${creds.email} (fonte: ${creds.fonte})`);
  console.log("Abrindo o navegador e logando…\n");

  const r = await iniciarReauth({ porEmail: "script-local" });
  if (r.estado === "concluido") {
    console.log("✅ Login concluído SEM 2FA (dispositivo já confiável). Sessão persistida.");
  } else {
    console.log(`📧 2FA solicitado — verifique o e-mail ${r.email}.`);
    const codigo = await pergunta("Digite o código 2FA recebido: ");
    await confirmarReauth({ challengeId: r.challengeId, codigo });
    console.log("✅ Código aceito; sessão capturada e persistida (cifrada).");
  }

  const st = await statusSessao();
  console.log("\nStatus da sessão:", { status: st.status, valida_ate: st.valida_ate });

  console.log("\nTestando o caminho de cotação (obterTokensSegfy + sessão)…");
  const sessao = await restaurarSessao();
  await obterTokensSegfy(true, { email: creds.email, password: creds.password }, sessao ?? undefined);
  console.log("✅ Tokens de automação obtidos via HTTP.");
  console.log("\n🎉 OK: o scraping funciona depois do código e a sessão autentica a cotação.");
  process.exit(0);
}

main().catch((e) => {
  logger.error("[segfy:reauth] falhou", { erro: (e as Error).message });
  console.error("\n❌ Falhou:", (e as Error).message);
  process.exit(1);
});
