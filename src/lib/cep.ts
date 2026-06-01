/**
 * Consulta e validação de CEP — util compartilhado entre a tool `consultar_cep`
 * da Bia (claude.client) e o espelho de endereço no cadastro (bot.service).
 *
 * Provedores ("consulta nos Correios"): ViaCEP (primário) + BrasilAPI (fallback).
 * Ambos são públicos e gratuitos (sem credenciais). `consultarCep` NUNCA lança:
 * em erro de rede/404/CEP inexistente devolve null, e o chamador pede o
 * logradouro manualmente ao cliente.
 */
import axios from "axios";
import { logger } from "../utils/logger";

export interface EnderecoCep {
  /** Apenas dígitos (8). */
  cep: string;
  logradouro: string;
  bairro: string;
  cidade: string;
  uf: string;
}

/** Fetcher injetável (default: axios). Retorna status + corpo, sem lançar em 4xx/5xx. */
export type CepFetcher = (url: string) => Promise<{ status: number; data: unknown }>;

const TIMEOUT_MS = 5_000;

const fetcherPadrao: CepFetcher = async (url) => {
  const r = await axios.get(url, { timeout: TIMEOUT_MS, validateStatus: () => true });
  return { status: r.status, data: r.data };
};

/** CEP válido = 8 dígitos (após remover máscara). */
export function cepValido(bruto: string): boolean {
  return /^\d{8}$/.test((bruto ?? "").replace(/\D/g, ""));
}

/** Formata 8 dígitos como 00000-000. */
export function formatarCep(bruto: string): string {
  const d = (bruto ?? "").replace(/\D/g, "");
  return `${d.slice(0, 5)}-${d.slice(5, 8)}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Mapeia a resposta do ViaCEP. `erro: true` → CEP inexistente. */
function mapearViaCep(cep: string, data: unknown): EnderecoCep | null {
  const o = data as Record<string, unknown> | null;
  if (!o || o.erro === true || o.erro === "true") return null;
  return { cep, logradouro: str(o.logradouro), bairro: str(o.bairro), cidade: str(o.localidade), uf: str(o.uf) };
}

/** Mapeia a resposta do BrasilAPI ({ street, neighborhood, city, state }). */
function mapearBrasilApi(cep: string, data: unknown): EnderecoCep | null {
  const o = data as Record<string, unknown> | null;
  if (!o || typeof o.city !== "string") return null;
  return { cep, logradouro: str(o.street), bairro: str(o.neighborhood), cidade: str(o.city), uf: str(o.state) };
}

function msgErro(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Consulta o CEP e devolve o endereço estruturado, ou null se não encontrar.
 * Tenta ViaCEP; se falhar/erro, tenta BrasilAPI. Nunca lança.
 */
export async function consultarCep(
  bruto: string,
  deps?: { fetcher?: CepFetcher },
): Promise<EnderecoCep | null> {
  const cep = (bruto ?? "").replace(/\D/g, "");
  if (!/^\d{8}$/.test(cep)) return null;
  const fetcher = deps?.fetcher ?? fetcherPadrao;

  // 1) ViaCEP (primário)
  try {
    const { status, data } = await fetcher(`https://viacep.com.br/ws/${cep}/json/`);
    if (status === 200) {
      const e = mapearViaCep(cep, data);
      if (e) return e;
    }
  } catch (e) {
    logger.warn("[cep] ViaCEP falhou; tentando fallback", { erro: msgErro(e) });
  }

  // 2) BrasilAPI (fallback)
  try {
    const { status, data } = await fetcher(`https://brasilapi.com.br/api/cep/v1/${cep}`);
    if (status === 200) {
      const e = mapearBrasilApi(cep, data);
      if (e) return e;
    }
  } catch (e) {
    logger.warn("[cep] BrasilAPI falhou", { erro: msgErro(e) });
  }

  logger.warn("[cep] CEP não resolvido em nenhum provedor", { cep_len: cep.length });
  return null;
}
