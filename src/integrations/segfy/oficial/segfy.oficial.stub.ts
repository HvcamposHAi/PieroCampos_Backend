/**
 * STUB do provider oficial. Enquanto não há credenciais/documentação da API
 * comercial, toda chamada FALHA de forma clara e tipada
 * (`SegfyOficialNaoConfiguradaError`) — nunca devolve resultado vazio que pareça
 * sucesso. É o "implementador" da porta enquanto o transporte oficial não existe.
 *
 * Não é importado por nenhum caminho ativo (o registry segue no provider HTTP
 * atual). Existe para manter o contrato COMPILÁVEL e testável até a Segfy liberar
 * o acesso, quando um `segfy.oficial.http.ts` real substituirá este stub.
 */
import { SegfyOficialNaoConfiguradaError } from "../errors";
import type { SegfyOficialPort } from "./segfy.oficial.port";

export const segfyOficialStub: SegfyOficialPort = {
  nome: "segfy-oficial-stub",
  async autenticar() {
    throw new SegfyOficialNaoConfiguradaError();
  },
  async cotarAuto() {
    throw new SegfyOficialNaoConfiguradaError();
  },
  async obterApolice() {
    throw new SegfyOficialNaoConfiguradaError();
  },
  async listarComissoes() {
    throw new SegfyOficialNaoConfiguradaError();
  },
};
