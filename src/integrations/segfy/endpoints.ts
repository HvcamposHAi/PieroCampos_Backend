/**
 * Mapa de endpoints da API Segfy.
 *
 * CONFIRMADO no mapeamento (27/05/2026):
 *   - Base URL real: https://upfygate.segfy.com  (gateway UpFy) — NÃO api(-v2).segfy.com.
 *   - Auth: POST /auth/login com corpo { email, password }, JSON. (o path abaixo bate)
 *   - SSO em login.segfy.com.
 *
 * ⚠️ AINDA PENDENTE (gate parcial):
 *   - Shape da RESPOSTA de sucesso do login (campos do token) — o login direto
 *     retornou 401; confirmar via captura interativa (`npm run segfy:mapear`,
 *     login manual no form de login.segfy.com).
 *   - Paths de segurados/cotacoes/propostas/apolices/comissoes abaixo seguem
 *     HIPÓTESES (seção 3.2 do MD); confirmar/ajustar com o tráfego pós-login.
 */
export const SEGFY_ENDPOINTS = {
  auth: {
    login: "/auth/login",
    refresh: "/auth/refresh",
  },
  segurados: {
    base: "/segurados",
    byId: (id: string) => `/segurados/${encodeURIComponent(id)}`,
    buscarPorCpf: (cpf: string) => `/segurados?cpf=${encodeURIComponent(cpf)}`,
  },
  cotacoes: {
    auto: "/cotacoes/auto",
    byId: (id: string) => `/cotacoes/${encodeURIComponent(id)}`,
  },
  propostas: {
    base: "/propostas",
    byId: (id: string) => `/propostas/${encodeURIComponent(id)}`,
  },
  apolices: {
    base: "/apolices",
    byId: (id: string) => `/apolices/${encodeURIComponent(id)}`,
  },
  comissoes: {
    base: "/comissoes",
    byApolice: (apoliceId: string) => `/comissoes?apolice_id=${encodeURIComponent(apoliceId)}`,
  },
} as const;
