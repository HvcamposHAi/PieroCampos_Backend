/**
 * Máquina de estados da reauth 1-clique (segfy-reauth-orq.service). Mocka o Supabase
 * (coluna singleton `reauth_job`). Cobre: solicitar (idempotente), o flip atômico do
 * agente, troca de código, fases inválidas, TTL→expirada e o sigilo do código na UI.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const estado = vi.hoisted(() => ({ job: null as unknown }));

vi.mock("../src/integrations/whatsapp/supabase", () => ({
  getSupabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { reauth_job: estado.job }, error: null }) }),
      }),
      update: (patch: Record<string, unknown>) => {
        if ("reauth_job" in patch) estado.job = patch.reauth_job;
        return { eq: async () => ({ error: null }) };
      },
    }),
  }),
}));

import {
  solicitarReauth,
  pegarTrabalhoReauth,
  enviarCodigoReauth,
  agenteReportar,
  statusReauth,
  type ReauthJob,
} from "../src/services/segfy-reauth-orq.service";

beforeEach(() => {
  estado.job = null;
});

describe("solicitarReauth", () => {
  it("cria um job 'solicitada' e é idempotente enquanto em voo", async () => {
    const a = await solicitarReauth("op@x.com");
    expect(a.fase).toBe("solicitada");
    const b = await solicitarReauth("op@x.com");
    expect(b.jobId).toBe(a.jobId); // reusa o job em voo (não duplica)
  });
});

describe("pegarTrabalhoReauth (agente)", () => {
  it("flipa 'solicitada'→'abrindo' e não re-flipa na 2ª chamada", async () => {
    await solicitarReauth(null);
    const t1 = await pegarTrabalhoReauth();
    expect(t1?.fase).toBe("abrindo");
    const t2 = await pegarTrabalhoReauth();
    expect(t2?.fase).toBe("abrindo"); // continua abrindo (sem novo flip)
  });

  it("devolve o código só quando 'codigo_enviado'", async () => {
    const { jobId } = await solicitarReauth(null);
    await pegarTrabalhoReauth(); // abrindo
    await agenteReportar({ jobId, fase: "aguardando_codigo", email: "op@x.com" });
    await enviarCodigoReauth({ jobId, codigo: "123456" });
    const t = await pegarTrabalhoReauth();
    expect(t?.fase).toBe("codigo_enviado");
    expect(t?.codigo).toBe("123456");
  });
});

describe("enviarCodigoReauth", () => {
  it("só aceita em 'aguardando_codigo'", async () => {
    const { jobId } = await solicitarReauth(null);
    // ainda 'solicitada' → rejeita
    expect((await enviarCodigoReauth({ jobId, codigo: "111111" })).ok).toBe(false);
    await pegarTrabalhoReauth();
    await agenteReportar({ jobId, fase: "aguardando_codigo" });
    expect((await enviarCodigoReauth({ jobId, codigo: "222222" })).ok).toBe(true);
  });

  it("rejeita jobId desconhecido", async () => {
    await solicitarReauth(null);
    expect((await enviarCodigoReauth({ jobId: "outro", codigo: "123456" })).erro).toBe("job_invalido");
  });
});

describe("statusReauth (UI)", () => {
  it("NUNCA devolve o código e reflete a fase", async () => {
    const { jobId } = await solicitarReauth(null);
    await pegarTrabalhoReauth();
    await agenteReportar({ jobId, fase: "aguardando_codigo", email: "op@x.com" });
    await enviarCodigoReauth({ jobId, codigo: "999999" });
    const s = await statusReauth(jobId);
    expect(s.fase).toBe("codigo_enviado");
    expect((s as Record<string, unknown>).codigo).toBeUndefined();
    expect(s.email).toBe("op@x.com");
  });

  it("idle quando não há job ou jobId não confere", async () => {
    expect((await statusReauth()).fase).toBe("idle");
    await solicitarReauth(null);
    expect((await statusReauth("inexistente")).fase).toBe("idle");
  });

  it("expira por TTL (job velho em fase não-terminal)", async () => {
    await solicitarReauth(null);
    const velho = estado.job as ReauthJob;
    estado.job = { ...velho, criada_em: new Date(Date.now() - 10 * 60_000).toISOString() };
    expect((await statusReauth()).fase).toBe("expirada");
  });
});

describe("agenteReportar concluída", () => {
  it("limpa o código ao finalizar", async () => {
    const { jobId } = await solicitarReauth(null);
    await pegarTrabalhoReauth();
    await agenteReportar({ jobId, fase: "aguardando_codigo" });
    await enviarCodigoReauth({ jobId, codigo: "123456" });
    await agenteReportar({ jobId, fase: "concluida", mensagem: "ok" });
    const t = await pegarTrabalhoReauth();
    expect(t).toBeNull(); // terminal → agente não pega mais
    expect((estado.job as ReauthJob).codigo).toBeNull();
  });
});
