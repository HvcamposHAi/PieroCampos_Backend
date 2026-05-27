/**
 * Descoberta SEGURA do contrato de resposta do login (uma única chamada).
 *
 * POST {SEGFY_API_URL}/auth/login com as credenciais do .env e imprime APENAS
 * a ESTRUTURA da resposta (nomes de campo + tipos; para campos sensíveis, só o
 * comprimento). NUNCA imprime o valor do token. Serve para confirmar/ajustar
 * AuthResponseSchema em segfy.types.ts.
 *
 * Uso: npm --prefix ".\PieroCampos_Backend" run segfy:descobrir-auth
 */
import axios from "axios";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";

function ehSensivel(chave: string): boolean {
  return /token|senha|password|secret|authorization/i.test(chave);
}

/** Descreve a estrutura sem vazar valores sensíveis. */
function descreverEstrutura(valor: unknown, chavePai = ""): unknown {
  if (valor === null || typeof valor !== "object") {
    if (ehSensivel(chavePai)) {
      return `<${typeof valor}${typeof valor === "string" ? `, len=${(valor as string).length}` : ""}>`;
    }
    // valores não-sensíveis e curtos podem ajudar (ex.: expires_in)
    if (typeof valor === "number" || typeof valor === "boolean") return valor;
    if (typeof valor === "string") return valor.length <= 24 ? valor : `<string, len=${valor.length}>`;
    return typeof valor;
  }
  if (Array.isArray(valor)) return valor.slice(0, 1).map((v) => descreverEstrutura(v, chavePai));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
    out[k] = descreverEstrutura(v, k);
  }
  return out;
}

async function main(): Promise<void> {
  const env = getEnv();
  if (!env.SEGFY_API_URL) {
    logger.error("SEGFY_API_URL não configurada.");
    process.exit(1);
  }
  const url = `${env.SEGFY_API_URL.replace(/\/+$/, "")}/auth/login`;
  logger.info("Descobrindo contrato de auth", { url });

  try {
    const resp = await axios.post(
      url,
      { email: env.SEGFY_LOGIN, password: env.SEGFY_SENHA },
      { headers: { "Content-Type": "application/json", Accept: "application/json" }, timeout: 30_000, validateStatus: () => true },
    );
    logger.info("Resposta do login", {
      status: resp.status,
      contentType: resp.headers["content-type"],
      estrutura: descreverEstrutura(resp.data),
    });
  } catch (e) {
    logger.error("Falha na chamada de auth", { mensagem: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  }
}

void main();
