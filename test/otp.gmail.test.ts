/**
 * Teste pontual do fallback de 2FA via Gmail (buscarOTPSegfy):
 *   - sem credenciais → erro claro;
 *   - com e-mail recente da Segfy → extrai o código de 6 dígitos;
 *   - NUNCA loga o código (requisito de segurança).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("axios", () => ({
  default: { post: vi.fn(), get: vi.fn() },
}));

import axios from "axios";
import { buscarOTPSegfy } from "../src/integrations/gmail/otp.gmail";
import { _resetEnvCache } from "../src/config/env";
import { logger } from "../src/utils/logger";

const mockedPost = vi.mocked(axios.post);
const mockedGet = vi.mocked(axios.get);

function setEnv(gmail: boolean): void {
  process.env.WA_ENABLED = "false";
  process.env.BIA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "false";
  if (gmail) {
    process.env.GMAIL_CLIENT_ID = "cid";
    process.env.GMAIL_CLIENT_SECRET = "csecret";
    process.env.GMAIL_REFRESH_TOKEN_PIERO = "rtoken";
  } else {
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;
    delete process.env.GMAIL_REFRESH_TOKEN_PIERO;
  }
  _resetEnvCache();
}

describe("buscarOTPSegfy", () => {
  beforeEach(() => {
    mockedPost.mockReset();
    mockedGet.mockReset();
  });

  it("lança erro quando faltam credenciais Gmail", async () => {
    setEnv(false);
    await expect(buscarOTPSegfy()).rejects.toThrow(/Gmail OTP indispon/i);
  });

  it("extrai o código de 6 dígitos de um e-mail recente da Segfy", async () => {
    setEnv(true);
    mockedPost.mockResolvedValue({ data: { access_token: "tok" } } as never);
    mockedGet
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: { internalDate: String(Date.now()), snippet: "Seu codigo de acesso e 482913" },
      } as never);

    const codigo = await buscarOTPSegfy();
    expect(codigo).toBe("482913");
  });

  it("nunca loga o valor do código OTP", async () => {
    setEnv(true);
    const spy = vi.spyOn(logger, "info");
    mockedPost.mockResolvedValue({ data: { access_token: "tok" } } as never);
    mockedGet
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: { internalDate: String(Date.now()), snippet: "codigo 654321" },
      } as never);

    await buscarOTPSegfy();
    const tudoLogado = spy.mock.calls.map((c) => JSON.stringify(c)).join(" ");
    expect(tudoLogado).not.toContain("654321");
    spy.mockRestore();
  });
});
