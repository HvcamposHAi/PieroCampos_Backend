/**
 * Erros tipados do módulo Segfy. Mantidos AQUI (no módulo isolado) para que tanto
 * o módulo quanto a camada de serviço possam reconhecê-los sem depender de
 * Supabase/Express. Nunca carregam PII/token na mensagem.
 */

/** Mensagem padrão (amigável) exibida ao operador na aba "Etapas Segfy". */
export const MSG_REAUTH_NECESSARIA =
  "Sessão do Segfy expirada — reautentique em Admin › Segfy (código 2FA).";

/**
 * Lançado quando o login no Segfy cai no desafio de 2FA e NÃO há sessão confiável
 * válida para contorná-lo (ausente/expirada). Sinaliza à camada de cotação que a
 * falha é de SESSÃO (operador precisa reautenticar), distinta de um erro genérico
 * de credencial/rede. A cotação trata como etapa "token"/erro (não quebra o bot).
 */
export class SegfyReauthNecessariaError extends Error {
  readonly code = "segfy_reauth_necessaria";
  constructor(message: string = MSG_REAUTH_NECESSARIA) {
    super(message);
    this.name = "SegfyReauthNecessariaError";
  }
}
