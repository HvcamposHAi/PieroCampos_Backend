/**
 * Erros tipados do módulo Aggilizador. Mantidos no módulo isolado para que tanto
 * o módulo quanto a camada de serviço os reconheçam sem depender de Supabase/
 * Express. Nunca carregam PII/token/senha na mensagem.
 *
 * NOTA: o Aggilizador NÃO tem 2FA (auth 100% REST stateless por JWT — ver
 * `aggilizador.auth.ts`), então NÃO há equivalente ao `SegfyReauthNecessariaError`.
 * Credencial inválida é um erro de configuração (operador corrige no Admin), não
 * um desafio de sessão a contornar.
 */

/**
 * Falha de AUTENTICAÇÃO no Aggilizador: credenciais inválidas (HTTP 401/403) ou
 * resposta de login sem token. O operador deve corrigir o login/senha no Admin.
 */
export class AggilizadorAuthError extends Error {
  readonly code = "aggilizador_auth_falhou";
  constructor(message = "Falha ao autenticar no Aggilizador (verifique login/senha em Admin).") {
    super(message);
    this.name = "AggilizadorAuthError";
  }
}

/**
 * Corretora sem permissão/condição para cotar no Aggilizador: `statusCorretora`
 * diferente de 1 (suspensa), licença vencida, ou módulo AUTO não contratado.
 * Distinto de credencial inválida — aqui o login funciona, mas a conta não habilita.
 */
export class AggilizadorConfigError extends Error {
  readonly code = "aggilizador_config_invalida";
  constructor(message = "Conta do Aggilizador sem permissão para cotação de auto.") {
    super(message);
    this.name = "AggilizadorConfigError";
  }
}
