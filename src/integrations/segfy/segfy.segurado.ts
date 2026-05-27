/**
 * CRUD de segurado no Segfy. O "segurado" Segfy corresponde ao `clientes`
 * do nosso banco (não há tabela `segurados` local).
 */
import { logger } from "../../utils/logger";
import { segfyAPI } from "./segfy.api";
import { SEGFY_ENDPOINTS } from "./endpoints";
import { SeguradoSegfySchema, SeguradoResponseSchema, type SeguradoSegfy } from "./segfy.types";

/** Extrai o primeiro id de uma resposta de busca (forma exata a confirmar no mapeamento). */
function extrairPrimeiroId(resp: unknown): string | null {
  const lista = Array.isArray(resp) ? resp : (resp as { data?: unknown }).data;
  if (Array.isArray(lista)) {
    const item = lista.find((x) => x !== null && typeof (x as { id?: unknown }).id === "string");
    return item ? String((item as { id: string }).id) : null;
  }
  if (resp !== null && typeof resp === "object" && typeof (resp as { id?: unknown }).id === "string") {
    return String((resp as { id: string }).id);
  }
  return null;
}

export async function buscarSeguradoPorCPF(cpf: string): Promise<{ id: string } | null> {
  const resp = await segfyAPI("GET", SEGFY_ENDPOINTS.segurados.buscarPorCpf(cpf));
  const id = extrairPrimeiroId(resp);
  return id ? { id } : null;
}

export async function criarOuAtualizarSegurado(dados: SeguradoSegfy): Promise<{ segfy_id: string }> {
  const valido = SeguradoSegfySchema.parse(dados);

  const existente = valido.cpf ? await buscarSeguradoPorCPF(valido.cpf) : null;

  if (existente) {
    await segfyAPI("PUT", SEGFY_ENDPOINTS.segurados.byId(existente.id), valido);
    logger.info("Segfy: segurado atualizado", { segfy_id: existente.id });
    return { segfy_id: existente.id };
  }

  const criado = SeguradoResponseSchema.parse(
    await segfyAPI("POST", SEGFY_ENDPOINTS.segurados.base, valido),
  );
  logger.info("Segfy: segurado criado", { segfy_id: criado.id });
  return { segfy_id: criado.id };
}
