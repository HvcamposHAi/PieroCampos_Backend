/**
 * Setup da corretora (Admin › Configuração da corretora). Reúne, ESCOPADO à
 * corretora efetiva: o SISTEMA de cotação (sistema/url/login/senha + status do
 * último teste) e os PRODUTOS (ramos habilitados). Seguradoras seguem na tela
 * /seguradoras (já por-corretora). Reusa os serviços existentes — sem lógica nova
 * de credencial/teste aqui.
 */
import {
  salvarCredenciaisSegfy,
  statusCredenciaisSegfy,
  type StatusCredenciais,
} from "../../services/segfy-credenciais.service";
import {
  lerRamosHabilitados,
  salvarRamosHabilitados,
} from "../../services/corretora-ramos.service";
import { RAMOS_VALIDOS, type Ramo } from "../../lib/roteiros";

export interface SetupCorretora {
  sistema: StatusCredenciais;
  ramos_disponiveis: readonly Ramo[];
  ramos_habilitados: string[];
}

export async function obterSetup(corretoraId: string): Promise<SetupCorretora> {
  const [sistema, habilitados] = await Promise.all([
    statusCredenciaisSegfy(corretoraId),
    lerRamosHabilitados(corretoraId),
  ]);
  return {
    sistema,
    ramos_disponiveis: RAMOS_VALIDOS,
    ramos_habilitados: [...habilitados],
  };
}

export async function salvarSistema(
  corretoraId: string,
  input: {
    sistema: string;
    url: string | null;
    email: string;
    senha: string;
    comissaoPadrao?: number | null;
    porEmail?: string | null;
  },
): Promise<void> {
  await salvarCredenciaisSegfy({
    corretoraId,
    sistema: input.sistema,
    url: input.url,
    email: input.email,
    senha: input.senha,
    comissaoPadrao: input.comissaoPadrao,
    porEmail: input.porEmail,
  });
}

export async function salvarProdutos(corretoraId: string, ramos: Ramo[]): Promise<void> {
  await salvarRamosHabilitados(corretoraId, ramos);
}
