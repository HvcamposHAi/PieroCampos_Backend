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

/**
 * API de AUTOMAÇÃO / MULTICÁLCULO (HFy) — ✅ CONFIRMADA na captura interativa
 * (29/05/2026, rota /multicalculo/hfy-auto, form embutido em iframe).
 *
 * Host: https://api.automation.segfy.com
 * Namespace: POST /api/{recurso}/version/1.0/{ação}
 * Envelope de REQUEST:  { data: {...}, config: { token } }
 * Envelope de RESPONSE: { status: "OK"|..., guid, message, data, perform }
 *
 * 🔑 TOKEN: vem de upfygate.segfy.com/automation/api/profile/version/1.0/find-by-user
 *   com body { config: { intranet_id: <assinaturaId>, user_id: <usuarioId> } }
 *   → resp.data.token. Esse token vai em `config.token` de TODA chamada abaixo.
 *   (intranet_id/usuarioId vêm do /auth/login — ver getIdentidadeSegfy()).
 *
 * Cotação = RPA: os "robôs" Segfy logam nos portais das 17 seguradoras
 * (credentials_active=17). Pode exigir a extensão de navegador Segfy para alguns
 * portais. is_multify=false nesta conta.
 */
export const SEGFY_AUTOMATION_BASE_URL = "https://api.automation.segfy.com";
/** Host do "Gestão" (salva o orçamento + provável leitura de resultados). */
export const SEGFY_GESTAO_BASE_URL = "https://gestao.segfy.com";

/**
 * Fluxo de cotação Auto — ✅ CONFIRMADO na captura interativa (30/05/2026):
 *   1) insured  (busca segurado por CPF)
 *   2) professionList / decodePlate (placa→FIPE) / modelList  (resolução de dados)
 *   3) calculate  → DISPARA o multicálculo; devolve { data: { quotation_id, ... } }
 *   4) SalvaCotacaoAutomation (host gestao) → salva o orçamento; devolve o id (string)
 *   5) resultados por seguradora chegam ASSÍNCRONOS via `callback` (WebSocket) —
 *      ⚠️ AINDA NÃO CAPTURADO (xhr/fetch não pega ws). Recapturar com WS.
 */
export const SEGFY_AUTOMATION_API = {
  // ✅ Init do form Auto:
  partnersList: "/api/partners/version/1.0/list", // { config:{token} } → { data:{ partners:[...] } }
  vehicleBrandList: "/api/vehicle/version/1.0/brand-list", // { data:{vehicle_type:"car"}, config:{token} }
  vehicleCompanyList: "/api/vehicle/version/1.0/company-list", // → seguradoras [{id,name,nome,commission}]
  templateIndex: "/api/template/version/1.0/index", // { config:{ parent_name:"coverage_vehicle", token } } → coberturas
  // ✅ Resolução de dados da cotação:
  insured: "/api/vehicle/version/1.0/insured", // { data:{document}, config:{token} } → segurado {id,name,birth_date,gender,...}
  professionList: "/api/vehicle/version/1.0/profession-list", // { data:{profession} } → [{id,name}] (autocomplete)
  decodePlate: "/api/vehicle/version/1.0/decode-plate", // { data:{plate} } → {manufacture_year,model_year,chassis,brands[],models[{...,data_fipe:{fipe_code,fipe_value}}]}
  modelList: "/api/vehicle/version/1.0/model-list", // { data:{brand,brand_id,model,model_year,vehicle_type} } → modelos
  // ✅ DISPARO do multicálculo:
  calculate: "/api/vehicle/version/1.0/calculate", // { data:{renewal,customer,main_driver,vehicle,questionnaire,coverage,...}, config:{insurers:[{name,commission}],callback,token} } → { data:{ quotation_id, ... } }
} as const;

/** Endpoints no host gestao.segfy.com (não upfygate, não api.automation). */
export const SEGFY_GESTAO_API = {
  // ✅ Salva o orçamento da automação. Query: ?codigoOrcamento=&token=...
  // Body { quotation_id, token, data:{...quote...}, config:{insurers,callback,...}, tipo_multicalculo:"Auto" } → "<idOrcamento>" (string).
  salvaCotacaoAutomation: "/api/Orcamento/SalvaCotacaoAutomation",
  // ⚠️ PENDENTE: leitura dos resultados (preços por seguradora). Provavelmente
  // por WebSocket (callback) ou poll do id retornado. Recapturar com WS ligado.
} as const;
