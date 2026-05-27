/**
 * Harness CLI — roda o fluxo Segfy isolado (sem bot/Twilio), usando uma
 * persistência em memória. Serve para smoke manual end-to-end.
 *
 * ⚠️ Faz chamadas REAIS ao Segfy: só executa com SEGFY_ENABLED=true e
 * credenciais + SEGFY_API_URL configuradas (após o mapeamento).
 * Uso: SEGFY_ENABLED=true npm run segfy:harness
 */
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import { InMemoryPersistence } from "../integrations/segfy/persistence.port";
import { SegfyClient, type DadosFormularioPiero } from "../integrations/segfy/segfy.client";
import { formatarComparativoParaWhatsApp } from "../integrations/segfy/segfy.format";

async function main(): Promise<void> {
  const env = getEnv();
  if (!env.SEGFY_ENABLED) {
    logger.warn("SEGFY_ENABLED=false — harness não executa contra o Segfy real. Saindo.");
    return;
  }

  const persistencia = new InMemoryPersistence();
  const clienteId = "cli_demo";
  persistencia.semearCliente({
    id: clienteId,
    nome: "Cliente Demo",
    cpf: "00000000000",
    email: "demo@example.com",
    telefone: "+5541999999999",
    segfy_id: null,
    consentimento_lgpd: true,
  });

  const dados: DadosFormularioPiero = {
    nome: "Cliente Demo",
    cpf: "00000000000",
    telefone: "+5541999999999",
    cep: "80000000",
    fipe_codigo: "001234-5",
    marca: "VW",
    modelo: "Polo",
    ano_modelo: 2022,
    ano_fabricacao: 2022,
    uso_veiculo: "particular",
    bonus_atual: 5,
    comissao_percentual: 15,
  };

  const client = new SegfyClient(persistencia);
  const { resultados } = await client.processarFormularioAuto({
    conversaId: null,
    clienteId,
    dados,
  });

  logger.info("Comparativo (preview):");
  process.stdout.write(formatarComparativoParaWhatsApp(resultados, dados.nome) + "\n");
}

void main().catch((e) => {
  logger.error("Harness falhou", { mensagem: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
