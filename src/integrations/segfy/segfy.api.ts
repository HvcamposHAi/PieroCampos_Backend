/**
 * Cliente HTTP genérico da API Segfy (transporte).
 *
 * Endpoint-agnóstico: os módulos de negócio passam method/endpoint/data.
 * - Injeta Authorization: Bearer <token> (via segfy.auth).
 * - Em 401, invalida o token e tenta UMA vez mais.
 * - `segfyAPIComRetry` adiciona backoff para erros transitórios (rede/5xx),
 *   sem repetir erros de negócio (400/422).
 * Nunca logamos token nem corpo de credenciais.
 */
import axios from "axios";
import { logger } from "../../utils/logger";
import { baseUrl, getToken, invalidarToken } from "./segfy.auth";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

const TIMEOUT_MS = 30_000;

export async function segfyAPI<T = unknown>(
  method: HttpMethod,
  endpoint: string,
  data?: unknown,
  _jaRenovou = false,
): Promise<T> {
  const token = await getToken();

  try {
    const resp = await axios.request<T>({
      method,
      url: endpoint.startsWith("http") ? endpoint : `${baseUrl()}${endpoint}`,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data,
      timeout: TIMEOUT_MS,
    });
    return resp.data;
  } catch (error: unknown) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;

    // Token expirado/inválido: renova e tenta uma única vez.
    if (status === 401 && !_jaRenovou) {
      invalidarToken();
      return segfyAPI<T>(method, endpoint, data, true);
    }

    const mensagem = axios.isAxiosError(error)
      ? ((error.response?.data as { message?: string } | undefined)?.message ?? error.message)
      : error instanceof Error
        ? error.message
        : "erro desconhecido";

    logger.error("Segfy API erro", { method, endpoint, status, mensagem });
    throw error;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function segfyAPIComRetry<T>(
  fn: () => Promise<T>,
  maxTentativas = 3,
  delayMs = 2_000,
): Promise<T> {
  let ultimoErro: unknown;

  for (let i = 0; i < maxTentativas; i++) {
    try {
      return await fn();
    } catch (error: unknown) {
      ultimoErro = error;
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;

      // Erros de negócio não devem ser repetidos.
      if (status === 400 || status === 422) throw error;

      logger.warn(`Segfy: tentativa ${i + 1}/${maxTentativas} falhou`, {
        status,
        mensagem: error instanceof Error ? error.message : String(error),
      });
      await sleep(delayMs * (i + 1)); // backoff linear-crescente
    }
  }
  throw ultimoErro;
}
