/**
 * Mapa de endpoints da API Segfy.
 *
 * ✅ CONFIRMADO no mapeamento automatizado (29/05/2026 — tráfego pós-login real):
 *   - Base URL: https://upfygate.segfy.com (gateway UpFy).
 *   - Auth: POST /auth/login { email, password } → 200 com envelope
 *     { data: { token, usuarioId, assinaturaId, acessoMC, mfaRequired, ... }, success, code }.
 *     ⚠️ O POST direto SEM o passo de SSO retorna 401 (visto no mapa: 1º /auth/login=401,
 *     depois POST api.sso.segfy.com/login {idToken}=200, então /auth/login=200). Ou seja,
 *     login 100% REST não basta — exige o idToken do SSO. Na prática: token via scraper
 *     (browser faz o SSO) OU usuário de serviço/idToken. `data.acessoMC=true` confirma
 *     acesso ao MULTICÁLCULO.
 *   - Dashboard (contadores): GET gestao.segfy.com/api/PropostaDashboard/DashboardPropostasInfo.
 *   - Notificações: GET /notifications/Count; Tarefas: GET /bgt/api/Task/Count.
 *
 * 🔑 ARQUITETURA DO MULTICÁLCULO (descoberta): a automação roda no namespace
 *   /automation/api/... (UpFy), versionado. Ex. confirmado:
 *     POST /automation/api/profile/version/1.0/find-by-user
 *       body { config: { intranet_id: <assinaturaId>, user_id: <usuarioId> } }
 *       → { data: { token, is_multify, credentials_active, export_quotation, ... } }
 *   credentials_active=17 = seguradoras configuradas. A cotação/segurado/proposta
 *   ficam SOB ESTE namespace — NÃO em /cotacoes/auto (hipótese antiga, provavelmente errada).
 *
 * ⚠️ AINDA PENDENTE (precisa de captura INTERATIVA com operações reais — o mapa
 *   automatizado é read-only e não cria dado): os paths exatos de criar segurado,
 *   disparar cotação (multicálculo) e proposta sob /automation/api/...
 *   Rodar `npm run segfy:mapear` e executar 1 cotação para capturá-los.
 */
export const SEGFY_ENDPOINTS = {
  auth: {
    login: "/auth/login", // ✅ confirmado (envelope { data: { token, ... } })
    refresh: "/auth/refresh", // ⚠️ não observado no mapa; manter como hipótese
  },
  // ✅ Confirmados no tráfego pós-login (read-only):
  automation: {
    // intranet_id = assinaturaId; user_id = usuarioId (do /auth/login).
    profileFindByUser: "/automation/api/profile/version/1.0/find-by-user",
  },
  dashboard: {
    // host: gestao.segfy.com (não upfygate).
    propostasInfo: "/api/PropostaDashboard/DashboardPropostasInfo",
  },
  notificacoes: {
    count: "/notifications/Count",
    tarefasCount: "/bgt/api/Task/Count",
  },
  // ⚠️⚠️ HIPÓTESES PROVAVELMENTE ERRADAS — manter só como placeholder até a
  // captura interativa. O fluxo real de segurado/cotação/proposta é via
  // /automation/api/... (ver bloco `automation` acima), NÃO estes paths REST.
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
