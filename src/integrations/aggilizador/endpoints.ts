/**
 * Mapa de endpoints do Aggilizador — ✅ CONFIRMADO via HAR de sessão real
 * (11/06/2026, corretora SISTEMA SUL). O Aggilizador é um multicálculo HTTP/JSON
 * apoiado em DOIS backends distintos (sem RPA, sem 2FA, auth stateless por JWT):
 *
 *   - PROD (`api-prod.aggilizador.com.br`): auth, config da corretora,
 *     credenciais das seguradoras e o DISPARO do cálculo (`/calculo/calcularV2`).
 *   - MULTICALCULO (`api.multicalculo.net`): motor de cotação — FIPE, CEP, placa
 *     e o POLLING dos resultados por seguradora.
 *
 * O token PRINCIPAL (login) autoriza o host PROD; o token `pdocs` (login
 * secundário) autoriza o host MULTICALCULO. Ramo auto = 31 (código SUSEP).
 */

/** Host do backend principal do Aggilizador (auth, config, disparo). */
export const AGGILIZADOR_PROD_BASE_URL = "https://api-prod.aggilizador.com.br";
/** Host do motor Multicálculo (lookups + polling de resultados). */
export const AGGILIZADOR_MULTICALCULO_BASE_URL = "https://api.multicalculo.net";

/** Código SUSEP do ramo automóvel (usado em filtros do motor). */
export const RAMO_AUTO_SUSEP = 31;

/** Endpoints no host PROD (Authorization: Bearer <tokenPrincipal>). */
export const AGGILIZADOR_PROD_API = {
  /** POST { email, senha } → 201 { token, expires, corretoraId, statusCorretora, permissoesCorretora, ... } */
  login: "/usuario/login?device=desktop",
  /** POST {} (Bearer do login) → 201 { token, expires } — token p/ o motor Multicálculo. */
  loginPdocs: "/usuario/login/pdocs",
  /** GET → seguradoras configuradas da corretora (login/senha/seguradora/ativo/credenciaisValidas). */
  seguradoraConfig: "/cfg/seguradora/config",
  /** GET → IDs de seguradoras a OMITIR do comparativo (ex.: [47,48,50,...]). */
  escondeLead: "/usuario/buscaSeguradorasEscondeLead",
  /** GET ?cpfCnpj=&simplificado=true&apenasBuscaLocal=false → pré-preenche segurado. */
  cadastroCliente: (cpf: string): string =>
    `/cadastros/cliente?cpfCnpj=${encodeURIComponent(cpf)}&simplificado=true&apenasBuscaLocal=false`,
  /** POST { cotacao: { segurado, calculos[], automovel, coberturas } } → { idIntegracao, versao }. */
  calcularV2: "/calculo/calcularV2",
} as const;

/** Endpoints no host MULTICALCULO (Authorization: Bearer <tokenMulticalculo>). */
export const AGGILIZADOR_MULTICALCULO_API = {
  /** GET → status operacional das seguradoras por ramo (1=ativo, -1=inativo, 0=degradado). */
  seguradoraStatus: "/app/seguradoraStatus/",
  /** GET ?cep= → [{ cep, logradouro, cidade, bairro, uf }]. */
  cep: (cep: string): string => `/calculo/cep?cep=${encodeURIComponent(cep)}`,
  /** GET ?placa= → { fipe, anoMod, anoFab, tipoVeic, placa, chassi, codFabr, modelo }. */
  buscaPlaca: (placa: string): string => `/calculo/buscaPlaca?placa=${encodeURIComponent(placa)}`,
  /** GET ?ano=&fipe=&zero=false → [{ id, modelo, tipo, fipeValores[] }]. */
  fipeModelo: (ano: string, fipe: string): string =>
    `/calculo/fipeModelo?ano=${encodeURIComponent(ano)}&fipe=${encodeURIComponent(fipe)}&zero=false`,
  /** GET ?cpfCnpj=&ramo=31 → [] se não houver cotação recente do segurado. */
  seguradoCotadoRecentemente: (cpf: string, ramo: number = RAMO_AUTO_SUSEP): string =>
    `/calculo/seguradoCotadoRecentemente?cpfCnpj=${encodeURIComponent(cpf)}&ramo=${ramo}`,
  /** GET /{idIntegracao}/{versao} → [{ seguradoraTxt, retorno, premio, retornoErro, ... }]. */
  pollingResultados: (idIntegracao: string, versao: number | string): string =>
    `/calculo/cotacao/calculos/${encodeURIComponent(idIntegracao)}/${encodeURIComponent(String(versao))}`,
} as const;
