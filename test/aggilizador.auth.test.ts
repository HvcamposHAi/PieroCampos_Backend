/**
 * Autenticação no Aggilizador (HTTP, 2 tokens, sem 2FA). Mocka axios.request
 * (a camada `aggilizador.http` centraliza as chamadas via axios.request).
 * Cobre: login feliz (login + pdocs), cache por e-mail, credencial inválida
 * (401 → AggilizadorAuthError) e conta sem permissão (statusCorretora/AUTO →
 * AggilizadorConfigError).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import axios from "axios";
import {
  loginAggilizador,
  isTokenValido,
  _resetAuthCache,
} from "../src/integrations/aggilizador/aggilizador.auth";
import { AggilizadorAuthError, AggilizadorConfigError } from "../src/integrations/aggilizador/errors";

const CRED = { email: "karla@sul.com.br", senha: "x" };
const FUTURO = Date.now() + 3 * 60 * 60 * 1000;

function loginOk(extra: Record<string, unknown> = {}) {
  return {
    data: {
      token: "JWT_PRINCIPAL",
      expires: FUTURO,
      corretoraId: "corr-1",
      statusCorretora: 1,
      permissoesCorretora: { AUTO: { id: 1, contratado: true } },
      ...extra,
    },
  };
}
const pdocsOk = { data: { token: "JWT_MC", expires: FUTURO } };

beforeEach(() => {
  _resetAuthCache();
  vi.restoreAllMocks();
});

describe("loginAggilizador", () => {
  it("login + pdocs → dois tokens", async () => {
    const post = vi.spyOn(axios, "request").mockResolvedValueOnce(loginOk()).mockResolvedValueOnce(pdocsOk);
    const s = await loginAggilizador(CRED);
    expect(s.tokenPrincipal).toBe("JWT_PRINCIPAL");
    expect(s.tokenMulticalculo).toBe("JWT_MC");
    expect(s.corretoraId).toBe("corr-1");
    expect(post).toHaveBeenCalledTimes(2);
    expect(isTokenValido(s.expires)).toBe(true);
  });

  it("reusa o cache na 2ª chamada (não bate na rede de novo)", async () => {
    const post = vi.spyOn(axios, "request").mockResolvedValueOnce(loginOk()).mockResolvedValueOnce(pdocsOk);
    await loginAggilizador(CRED);
    await loginAggilizador(CRED);
    expect(post).toHaveBeenCalledTimes(2); // cache evitou o 2º par de chamadas
  });

  it("HTTP 401 → AggilizadorAuthError (credencial)", async () => {
    vi.spyOn(axios, "request").mockRejectedValueOnce({ isAxiosError: true, response: { status: 401 } });
    await expect(loginAggilizador(CRED)).rejects.toBeInstanceOf(AggilizadorAuthError);
  });

  it("statusCorretora != 1 → AggilizadorConfigError (conta suspensa)", async () => {
    vi.spyOn(axios, "request").mockResolvedValueOnce(loginOk({ statusCorretora: 0 }));
    await expect(loginAggilizador(CRED)).rejects.toBeInstanceOf(AggilizadorConfigError);
  });

  it("AUTO não contratado → AggilizadorConfigError", async () => {
    vi.spyOn(axios, "request").mockResolvedValueOnce(
      loginOk({ permissoesCorretora: { AUTO: { id: 1, contratado: false } } }),
    );
    await expect(loginAggilizador(CRED)).rejects.toBeInstanceOf(AggilizadorConfigError);
  });

  it("token ANINHADO em data → autentica (envelope alternativo)", async () => {
    vi.spyOn(axios, "request")
      .mockResolvedValueOnce({
        data: {
          data: {
            token: "JWT_P",
            expires: FUTURO,
            corretoraId: "corr-1",
            statusCorretora: 1,
            permissoesCorretora: { AUTO: { id: 1, contratado: true } },
          },
        },
      })
      .mockResolvedValueOnce({ data: { data: { token: "JWT_MC", expires: FUTURO } } });
    const s = await loginAggilizador({ email: "aninhado@x.com", senha: "x" });
    expect(s.tokenPrincipal).toBe("JWT_P");
    expect(s.tokenMulticalculo).toBe("JWT_MC");
  });

  it("sessão já ativa (HTTP 201 sem token) → erro acionável de sessão única", async () => {
    vi.spyOn(axios, "request").mockResolvedValue({
      status: 201,
      data: { message: "Já existe uma sessão ativa com esse usuário.", data: {}, idUsuarioAgger: 1, assinaturaId: 2 },
    });
    const err = (await loginAggilizador({ email: "sessao@x.com", senha: "x" }).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(AggilizadorAuthError);
    expect(err.message).toMatch(/sess[aã]o ativa|DEDICADO/i);
  });

  it("HTTP 400 → erro diagnóstico com status+motivo, SEM vazar a senha", async () => {
    const cred = { email: "k@x.com", senha: "SenhaSecreta#123" };
    vi.spyOn(axios, "request").mockRejectedValue({
      isAxiosError: true,
      response: { status: 400, data: { message: "device desktop obrigatório" } },
    });
    const err = (await loginAggilizador(cred).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(AggilizadorAuthError);
    expect(err.message).toMatch(/HTTP 400/);
    expect(err.message).toMatch(/device desktop/i);
    // a mensagem NUNCA pode conter a senha (vai para ultimo_teste_msg/tela).
    expect(err.message).not.toContain("SenhaSecreta#123");
  });
});
