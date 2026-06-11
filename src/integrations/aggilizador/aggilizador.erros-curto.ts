/**
 * Mensagem de erro CURTA e SEGURA para a aba Etapas — nunca token/CPF/senha.
 * Espelha `erroCurto` do Segfy: para erros HTTP (axios), extrai o motivo real do
 * corpo da resposta (que o axios esconde atrás de "Request failed with status…").
 */
import axios from "axios";

/** Mascara CPF (11 dígitos) e corta o comprimento. Nunca lança. */
function sanitizar(s: string, max = 180): string {
  return s.replace(/\b\d{11}\b/g, "***").slice(0, max);
}

export function erroCurtoAggilizador(e: unknown): string {
  try {
    if (axios.isAxiosError(e)) {
      const status = e.response?.status;
      const data = e.response?.data as
        | { message?: string; error?: string; detail?: string; errors?: unknown }
        | string
        | undefined;
      let motivo = "";
      if (typeof data === "string") motivo = data;
      else if (data) {
        motivo =
          (typeof data.message === "string" && data.message) ||
          (typeof data.error === "string" && data.error) ||
          (typeof data.detail === "string" && data.detail) ||
          (data.errors != null
            ? typeof data.errors === "string"
              ? data.errors
              : JSON.stringify(data.errors)
            : "") ||
          "";
      }
      const prefixo = status ? `HTTP ${status}` : "erro de rede";
      if (motivo) return sanitizar(`${prefixo}: ${motivo}`);
      // Sem corpo (típico de bloqueio de borda/WAF): aponta o servidor de borda
      // para o motivo ficar auto-evidente na tela (ex.: cloudflare/AWS).
      const h = (e.response?.headers ?? {}) as Record<string, unknown>;
      const borda = [h["server"], h["cf-ray"] ? "cf-ray" : "", h["via"]]
        .filter((x) => typeof x === "string" && x)
        .join(", ");
      if (status && borda) return sanitizar(`${prefixo} (bloqueio de borda — ${borda}; sem corpo)`);
      return sanitizar(`${prefixo}: ${e.message}`);
    }
  } catch {
    /* formato inesperado → fallback abaixo */
  }
  return sanitizar(e instanceof Error ? e.message : String(e));
}
