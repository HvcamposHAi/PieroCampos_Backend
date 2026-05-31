/**
 * Serviço de credenciais do Segfy: round-trip cifrar/decifrar, fallback .env e
 * status sem senha. Faka o getSupabaseAdmin (store em memória); cipher é real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const store = vi.hoisted(() => ({ row: null as Record<string, unknown> | null }));

vi.mock("../src/integrations/whatsapp/supabase", () => ({
  getSupabaseAdmin: () => ({
    from() {
      let op: "select" | "upsert" | "update" = "select";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let payload: any = null;
      const ctx = {
        select: () => ctx,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        upsert: (p: any) => {
          op = "upsert";
          payload = p;
          return ctx;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update: (p: any) => {
          op = "update";
          payload = p;
          return ctx;
        },
        eq: () => ctx,
        async maybeSingle() {
          return { data: store.row, error: null };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then(onF: (v: any) => unknown, onR?: (e: unknown) => unknown) {
          if (op === "upsert") store.row = { ...(store.row ?? {}), ...payload };
          else if (op === "update" && store.row) store.row = { ...store.row, ...payload };
          return Promise.resolve({ error: null }).then(onF, onR);
        },
      };
      return ctx;
    },
  }),
}));

import {
  obterCredenciaisSegfy,
  salvarCredenciaisSegfy,
  statusCredenciaisSegfy,
} from "../src/services/segfy-credenciais.service";
import { _resetEnvCache } from "../src/config/env";
import { _resetCipherCache } from "../src/integrations/whatsapp/cipher";

beforeEach(() => {
  store.row = null;
  process.env.WA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "false";
  process.env.BIA_ENABLED = "false";
  process.env.WA_AUTH_ENCRYPTION_KEY = "A".repeat(43) + "="; // 32 bytes base64
  delete process.env.SEGFY_LOGIN;
  delete process.env.SEGFY_SENHA;
  _resetEnvCache();
  _resetCipherCache();
});

describe("segfy-credenciais.service", () => {
  it("salva cifrado e obtém de volta o mesmo email/senha (round-trip, fonte=db)", async () => {
    await salvarCredenciaisSegfy({ email: "comercial1@x.com", senha: "S3nh@!", porEmail: "admin@x" });

    // Não guarda texto puro: senha_cifrada tem {iv,tag,ciphertext} e o JSON não contém a senha.
    const cif = store.row?.senha_cifrada as Record<string, unknown>;
    expect(cif).toHaveProperty("iv");
    expect(cif).toHaveProperty("tag");
    expect(cif).toHaveProperty("ciphertext");
    expect(JSON.stringify(store.row)).not.toContain("S3nh@!");

    const creds = await obterCredenciaisSegfy();
    expect(creds).toEqual({ email: "comercial1@x.com", password: "S3nh@!", fonte: "db" });
  });

  it("sem linha no banco e sem .env → null", async () => {
    expect(await obterCredenciaisSegfy()).toBeNull();
  });

  it("sem linha no banco mas com .env → fallback fonte=env", async () => {
    process.env.SEGFY_LOGIN = "env@x.com";
    process.env.SEGFY_SENHA = "envpass";
    _resetEnvCache();
    const creds = await obterCredenciaisSegfy();
    expect(creds).toEqual({ email: "env@x.com", password: "envpass", fonte: "env" });
  });

  it("status NUNCA inclui a senha", async () => {
    await salvarCredenciaisSegfy({ email: "comercial1@x.com", senha: "S3nh@!" });
    const s = await statusCredenciaisSegfy();
    expect(s.configurado).toBe(true);
    expect(s.fonte).toBe("db");
    expect(s.email).toBe("comercial1@x.com");
    expect(JSON.stringify(s)).not.toContain("S3nh@!");
    expect(s).not.toHaveProperty("senha");
    expect(s).not.toHaveProperty("password");
  });
});
