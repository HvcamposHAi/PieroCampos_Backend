// Fila de jobs do agente local (testar/emitir): enfileira → agente pega (flip) →
// reporta → status. Cobre idempotência, TTL, guarda de fase do código e que o
// status NUNCA devolve o código. Store em memória (sem Supabase) — determinístico.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _setJobStore,
  agenteReportar,
  enfileirar,
  enviarCodigo,
  pegarProximoTrabalho,
  statusJob,
  type ApoliceJob,
  type ApoliceJobStore,
} from "./apolice-job.service";

class MemStore implements ApoliceJobStore {
  jobs: ApoliceJob[] = [];
  async inserir(j: ApoliceJob): Promise<void> {
    this.jobs.push({ ...j });
  }
  async buscarPorId(id: string): Promise<ApoliceJob | null> {
    return this.jobs.find((j) => j.id === id) ?? null;
  }
  async buscarEmVoo(tipo: ApoliceJob["tipo"], alvo: string, corretoraId: string): Promise<ApoliceJob | null> {
    const col = tipo === "testar" ? "seguradora_config_id" : "proposta_id";
    return (
      this.jobs
        .filter(
          (j) =>
            j.corretora_id === corretoraId &&
            j.tipo === tipo &&
            (j as unknown as Record<string, string | null>)[col] === alvo &&
            !["concluida", "erro", "expirada"].includes(j.fase),
        )
        .at(-1) ?? null
    );
  }
  async proximoSolicitado(): Promise<ApoliceJob | null> {
    return (
      this.jobs.filter((j) => j.fase === "solicitada").sort((a, b) => a.criada_em.localeCompare(b.criada_em))[0] ?? null
    );
  }
  async atualizar(id: string, patch: Partial<ApoliceJob>): Promise<void> {
    const j = this.jobs.find((x) => x.id === id);
    if (j) Object.assign(j, patch);
  }
}

let store: MemStore;
beforeEach(() => {
  store = new MemStore();
  _setJobStore(store);
});
afterEach(() => {
  _setJobStore(new MemStore());
});

describe("apolice-job.service", () => {
  it("enfileira e é idempotente por (tipo, alvo, corretora)", async () => {
    const a = await enfileirar({ tipo: "testar", alvo: "seg-1", corretoraId: "c1" });
    expect(a.fase).toBe("solicitada");
    const b = await enfileirar({ tipo: "testar", alvo: "seg-1", corretoraId: "c1" });
    expect(b.jobId).toBe(a.jobId); // 2 cliques → 1 job
    expect(store.jobs).toHaveLength(1);
  });

  it("agente pega o próximo (solicitada → abrindo)", async () => {
    await enfileirar({ tipo: "testar", alvo: "seg-1", corretoraId: "c1" });
    const job = await pegarProximoTrabalho();
    expect(job?.fase).toBe("abrindo");
    expect(job?.seguradora_config_id).toBe("seg-1");
    expect(await pegarProximoTrabalho()).toBeNull(); // não há outro solicitada
  });

  it("agente reporta concluida → status reflete, sem código", async () => {
    const { jobId } = await enfileirar({ tipo: "emitir", alvo: "prop-1", corretoraId: "c1" });
    await pegarProximoTrabalho();
    await agenteReportar({ jobId, fase: "concluida", resultado: { apoliceId: "apo-1" } });
    const s = await statusJob(jobId);
    expect(s.fase).toBe("concluida");
    expect((s as Record<string, unknown>).codigo).toBeUndefined();
  });

  it("código 2FA só vale em aguardando_codigo", async () => {
    const { jobId } = await enfileirar({ tipo: "testar", alvo: "seg-2", corretoraId: "c1" });
    expect((await enviarCodigo({ jobId, codigo: "123456" })).erro).toBe("fase_invalida");
    await agenteReportar({ jobId, fase: "aguardando_codigo" });
    expect((await enviarCodigo({ jobId, codigo: "123456" })).ok).toBe(true);
    expect(store.jobs[0]!.fase).toBe("codigo_enviado");
  });

  it("job em voo expirado (TTL) → expirada e não é pego", async () => {
    const antigo = new Date(Date.now() - 10 * 60_000).toISOString(); // 10min atrás
    await store.inserir({
      id: "velho",
      corretora_id: "c1",
      tipo: "testar",
      seguradora_config_id: "seg-9",
      proposta_id: null,
      fase: "solicitada",
      codigo: null,
      resultado: null,
      mensagem: null,
      por: null,
      criada_em: antigo,
      atualizada_em: antigo,
    });
    expect(await pegarProximoTrabalho()).toBeNull();
    expect(store.jobs[0]!.fase).toBe("expirada");
  });
});
