/**
 * Catálogo ÚNICO de sistemas de cotação (multi-tenant: cada corretora escolhe o
 * seu em `segfy_credenciais.sistema`). É a FONTE DE VERDADE para:
 *   - resolução de provider automatizado (registry.ts → `AUTO_POR_SISTEMA`);
 *   - validação do `sistema` aceito (setup.routes — em vez de `z.enum` fixo);
 *   - teste de conexão por sistema (credenciais.routes — em vez de `if/else`);
 *   - a lista pública que o front usa p/ popular o select (`GET /api/setup/sistemas`).
 *
 * Plugar um 3º sistema = implementar o provider + a função de login e adicionar
 * UMA entrada aqui. Nada mais precisa saber o conjunto de sistemas.
 *
 * `exige2fa` descreve uma CAPACIDADE (não um detalhe de marca): o front mostra a
 * seção "Sessão / 2FA" só para sistemas que exigem 2FA (Segfy). Stateless
 * (Aggilizador) → a seção some.
 */
import type { QuoteProvider } from "./quote-provider.port";
import { segfyAutoProvider } from "./segfy-auto.provider";
import { aggilizadorAutoProvider } from "./aggilizador-auto.provider";
import { obterTokensSegfy } from "../segfy/segfy.multicalculo";
import { restaurarSessao } from "../../services/segfy-sessao.service";
import { loginAggilizador } from "../aggilizador/aggilizador.auth";

/** Credenciais para o teste de conexão (mesma forma de `obterCredenciaisSegfy`). */
export interface CredenciaisTeste {
  email: string;
  password: string;
}

export interface SistemaCotacao {
  /** id técnico, gravado em `segfy_credenciais.sistema`. */
  id: string;
  /** rótulo p/ exibição (o front prefere o termo neutro "sistema de cotação"). */
  label: string;
  /** true = cota sozinho (multicálculo automatizado). */
  automatizado: boolean;
  /** true = exige 2FA/sessão confiável (Segfy). Governa a seção "Sessão/2FA" na UI. */
  exige2fa: boolean;
  /** provider automatizado deste sistema (usado pelo registry no ramo auto). */
  provider: QuoteProvider;
  /** Valida as credenciais com login REAL; devolve a mensagem de sucesso p/ a tela. */
  testarConexao(creds: CredenciaisTeste): Promise<string>;
}

/** Default seguro quando a corretora não tem sistema definido. */
export const SISTEMA_PADRAO = "segfy";

export const SISTEMAS: Record<string, SistemaCotacao> = {
  segfy: {
    id: "segfy",
    label: "Segfy",
    automatizado: true,
    exige2fa: true,
    provider: segfyAutoProvider,
    async testarConexao(creds) {
      // forcar=true → login real (sem cache) com a SESSÃO importada (device-trust)
      // — espelha o caminho de cotação e valida se o cookie dispensa o 2FA.
      const sessao = await restaurarSessao();
      await obterTokensSegfy(true, { email: creds.email, password: creds.password }, sessao ?? undefined);
      return "Login no Segfy OK.";
    },
  },
  aggilizador: {
    id: "aggilizador",
    label: "Aggilizador",
    automatizado: true, // cota sozinho via HTTP (sem 2FA)
    exige2fa: false,
    provider: aggilizadorAutoProvider,
    async testarConexao(creds) {
      // forcar=true → login+pdocs reais; valida credencial e permissão AUTO.
      await loginAggilizador({ email: creds.email, senha: creds.password }, true);
      return "Login no Aggilizador OK.";
    },
  },
};

/** Forma pública (sem funções) p/ o front — popula o select e descobre `exige2fa`. */
export const SISTEMAS_PUBLICOS = Object.values(SISTEMAS).map(({ id, label, automatizado, exige2fa }) => ({
  id,
  label,
  automatizado,
  exige2fa,
}));

/** true se `id` é um sistema conhecido do catálogo. */
export function sistemaValido(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(SISTEMAS, id);
}

/** Retorna a entrada do catálogo (ou undefined p/ sistema desconhecido). */
export function getSistema(id: string | null | undefined): SistemaCotacao | undefined {
  return id ? SISTEMAS[id] : undefined;
}
