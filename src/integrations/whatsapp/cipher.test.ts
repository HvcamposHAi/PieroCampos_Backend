import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { _resetEnvCache } from "../../config/env";
import { _resetCipherCache, cifrar, decifrar } from "./cipher";

function setKey(base64: string): void {
  process.env.WA_AUTH_ENCRYPTION_KEY = base64;
  process.env.WA_ENABLED = "true";
  // Os outros campos exigidos pelo superRefine só ficam validados na hora;
  // o cipher só toca em WA_AUTH_ENCRYPTION_KEY, então preenchemos o mínimo
  // para o getEnv() não falhar.
  process.env.SUPABASE_URL = "http://localhost:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.SUPABASE_ANON_KEY = "anon";
  _resetEnvCache();
  _resetCipherCache();
}

describe("cipher (AES-256-GCM)", () => {
  beforeEach(() => {
    setKey(randomBytes(32).toString("base64"));
  });

  afterEach(() => {
    delete process.env.WA_AUTH_ENCRYPTION_KEY;
    delete process.env.WA_ENABLED;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_ANON_KEY;
    _resetEnvCache();
    _resetCipherCache();
  });

  it("faz round-trip de objeto JSON", () => {
    const original = { noiseKey: "abc", id: 42, nested: { a: [1, 2, 3] } };
    const payload = cifrar(original);
    expect(payload.iv).toBeTruthy();
    expect(payload.tag).toBeTruthy();
    expect(payload.ciphertext).toBeTruthy();
    expect(decifrar(payload)).toEqual(original);
  });

  it("gera IVs diferentes entre chamadas (não-determinístico)", () => {
    const a = cifrar({ x: 1 });
    const b = cifrar({ x: 1 });
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it("falha ao decifrar com chave diferente", () => {
    const payload = cifrar({ x: 1 });
    setKey(randomBytes(32).toString("base64"));
    expect(() => decifrar(payload)).toThrow();
  });

  it("falha ao decifrar com tag adulterada", () => {
    const payload = cifrar({ x: 1 });
    // Inverte um byte da tag.
    const tag = Buffer.from(payload.tag, "base64");
    tag[0] = (tag[0] ?? 0) ^ 0xff;
    expect(() => decifrar({ ...payload, tag: tag.toString("base64") })).toThrow();
  });

  it("rejeita chave com tamanho inválido", () => {
    setKey(Buffer.alloc(16).toString("base64"));
    expect(() => cifrar({ x: 1 })).toThrow(/32 bytes/);
  });
});
