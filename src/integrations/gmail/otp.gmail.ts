/**
 * Captura do código 2FA (OTP) que a Segfy passa a enviar por e-mail a partir de
 * 01/06/2026. Fallback para quando o login (REST/scraper) cair no desafio de
 * 2 fatores — o caminho primário continua sendo um usuário de serviço isento.
 *
 * Implementação via Gmail REST + OAuth2 (refresh token), usando `axios` — que
 * já é dependência — para NÃO arrastar o pacote pesado `googleapis` para o build
 * do Render. Lê apenas e-mails recentes de @segfy.com e extrai o código de 6
 * dígitos. NUNCA loga o código (só confirma "encontrado/expirado").
 */
import axios from "axios";
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Janela de busca: só consideramos e-mails recebidos nos últimos N ms. */
const JANELA_MS = 3 * 60 * 1000;
/** Timeout total do polling. */
const TIMEOUT_MS = 90 * 1000;
/** Intervalo entre tentativas. */
const INTERVALO_MS = 3 * 1000;
/** Remetente esperado (sufixo de domínio, tolerante a subdomínios). */
const DOMINIO_SEGFY = "segfy.com";
/** Código numérico de 6 dígitos isolado por borda de palavra. */
const REGEX_OTP = /\b(\d{6})\b/;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface TokenResponse {
  access_token: string;
}
interface MessageList {
  messages?: Array<{ id: string }>;
}
interface MessagePayloadPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: MessagePayloadPart[];
}
interface MessageFull {
  internalDate?: string; // epoch ms como string
  snippet?: string;
  payload?: MessagePayloadPart;
}

/** Troca o refresh token por um access token de curta duração. */
async function obterAccessToken(): Promise<string> {
  const env = getEnv();
  const resp = await axios.post<TokenResponse>(
    OAUTH_TOKEN_URL,
    new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN_PIERO,
      grant_type: "refresh_token",
    }),
    { timeout: 20_000, headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  );
  if (!resp.data?.access_token) {
    throw new Error("Gmail OAuth: resposta sem access_token");
  }
  return resp.data.access_token;
}

/** Decodifica base64url (formato do corpo das mensagens Gmail). */
function decodeBase64Url(data: string): string {
  const normalizado = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalizado, "base64").toString("utf8");
}

/** Concatena o texto de todas as partes (recursivo) + snippet. */
function extrairTexto(msg: MessageFull): string {
  const partes: string[] = [];
  if (msg.snippet) partes.push(msg.snippet);
  const visitar = (p?: MessagePayloadPart): void => {
    if (!p) return;
    if (p.body?.data) partes.push(decodeBase64Url(p.body.data));
    p.parts?.forEach(visitar);
  };
  visitar(msg.payload);
  return partes.join("\n");
}

/**
 * Busca o código OTP de 6 dígitos mais recente recebido de um DOMÍNIO remetente,
 * lendo a caixa Gmail configurada (refresh token). Faz polling até achar um
 * e-mail dentro da janela. Genérico: serve para a Segfy e para os portais de
 * seguradora que mandam código por e-mail (Akad/Justos/Tokio…).
 *
 * @throws se as credenciais Gmail não estiverem configuradas ou no timeout.
 */
export async function buscarOTPEmail(opts: {
  /** Sufixo de domínio do remetente (ex.: "tokiomarine.com.br"). */
  dominioRemetente: string;
  janelaMs?: number;
  timeoutMs?: number;
}): Promise<string> {
  const env = getEnv();
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN_PIERO) {
    throw new Error(
      "Gmail OTP indisponível: defina GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET e GMAIL_REFRESH_TOKEN_PIERO.",
    );
  }

  const janelaMs = opts.janelaMs ?? JANELA_MS;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const inicio = Date.now();
  const limiteRecebimento = inicio - janelaMs; // só e-mails desta janela
  const accessToken = await obterAccessToken();
  const auth = { headers: { Authorization: `Bearer ${accessToken}` } };
  // q restringe ao remetente e a 1 dia; a janela fina é validada por internalDate.
  const query = encodeURIComponent(`from:${opts.dominioRemetente} newer_than:1d`);

  logger.info("Gmail OTP: aguardando código por e-mail", { remetente: opts.dominioRemetente });

  while (Date.now() - inicio < timeoutMs) {
    const lista = await axios.get<MessageList>(
      `${GMAIL_API}/messages?q=${query}&maxResults=5`,
      { ...auth, timeout: 20_000 },
    );

    for (const ref of lista.data.messages ?? []) {
      const msg = await axios.get<MessageFull>(
        `${GMAIL_API}/messages/${encodeURIComponent(ref.id)}?format=full`,
        { ...auth, timeout: 20_000 },
      );
      const recebidoEm = Number(msg.data.internalDate ?? 0);
      if (recebidoEm < limiteRecebimento) continue; // antigo demais

      const texto = extrairTexto(msg.data);
      const codigo = REGEX_OTP.exec(texto)?.[1];
      if (codigo) {
        logger.info("Gmail OTP: código encontrado"); // nunca logamos o valor
        return codigo;
      }
    }

    await sleep(INTERVALO_MS);
  }

  throw new Error("Gmail OTP: código não recebido dentro do tempo limite");
}

/** Wrapper retrocompatível: OTP da Segfy (remetente @segfy.com). */
export async function buscarOTPSegfy(): Promise<string> {
  return buscarOTPEmail({ dominioRemetente: DOMINIO_SEGFY });
}
