/**
 * Teste PONTUAL do contrato da API oficial (stub). Garante que, enquanto não há
 * credenciais, toda chamada FALHA de forma clara e tipada — nunca devolve vazio
 * mascarado — e que a forma de entrada passa pelo schema Zod reusado do domínio.
 */
import { describe, it, expect } from "vitest";
import { segfyOficialStub } from "../src/integrations/segfy/oficial/segfy.oficial.stub";
import {
  SegfyOficialCotacaoInputSchema,
  type SegfyOficialCotacaoInput,
  type SegfyOficialToken,
} from "../src/integrations/segfy/oficial/segfy.oficial.types";
import { SegfyOficialNaoConfiguradaError } from "../src/integrations/segfy/errors";

const tokenFake: SegfyOficialToken = { accessToken: "tok", tokenType: "Bearer" };

const inputValido: SegfyOficialCotacaoInput = {
  segurado_id: "seg-1",
  veiculo: {
    placa: "ABC1D23",
    fipe_codigo: "001",
    marca: "VW",
    modelo: "Polo",
    ano_modelo: 2022,
    ano_fabricacao: 2022,
    uso: "particular",
    garagem: "coberta",
    cep_pernoite: "80000000",
    alienado: false,
    zero_km: false,
  },
  condutor_principal: {
    cpf: "09065661930",
    data_nascimento: "1990-01-01",
    estado_civil: "single",
    bonus_atual: 5,
  },
};

describe("contrato API oficial — stub não configurado", () => {
  it("a entrada de cotação passa pelo schema Zod reusado (forma válida)", () => {
    expect(() => SegfyOficialCotacaoInputSchema.parse(inputValido)).not.toThrow();
  });

  it("cotarAuto rejeita com erro tipado 'não configurada'", async () => {
    await expect(segfyOficialStub.cotarAuto(inputValido, tokenFake)).rejects.toThrow(/não configurada/);
    await expect(segfyOficialStub.cotarAuto(inputValido, tokenFake)).rejects.toMatchObject({
      code: "segfy_oficial_nao_configurada",
    });
  });

  it("autenticar/obterApolice/listarComissoes também falham tipado", async () => {
    await expect(
      segfyOficialStub.autenticar({ clientId: "id", clientSecret: "sec" }),
    ).rejects.toBeInstanceOf(SegfyOficialNaoConfiguradaError);
    await expect(segfyOficialStub.obterApolice("ap-1", tokenFake)).rejects.toBeInstanceOf(
      SegfyOficialNaoConfiguradaError,
    );
    await expect(segfyOficialStub.listarComissoes("ap-1", tokenFake)).rejects.toBeInstanceOf(
      SegfyOficialNaoConfiguradaError,
    );
  });
});
