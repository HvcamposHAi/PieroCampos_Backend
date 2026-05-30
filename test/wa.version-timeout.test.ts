/**
 * Testa o helper `comTimeout` usado no fetch da versão Baileys (defesa contra
 * fetch pendurado no cold start). Não toca rede.
 */
import { describe, it, expect } from "vitest";
import { comTimeout } from "../src/integrations/whatsapp/baileys.client";

describe("comTimeout", () => {
  it("resolve quando a promise termina antes do prazo", async () => {
    await expect(comTimeout(Promise.resolve("ok"), 50)).resolves.toBe("ok");
  });

  it("rejeita com timeout_<ms> quando a promise não termina a tempo", async () => {
    await expect(comTimeout(new Promise(() => {}), 20)).rejects.toThrow("timeout_20ms");
  });

  it("propaga a rejeição original se a promise falhar antes do prazo", async () => {
    await expect(comTimeout(Promise.reject(new Error("boom")), 50)).rejects.toThrow("boom");
  });
});
