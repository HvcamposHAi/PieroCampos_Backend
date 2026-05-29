/**
 * Testes da ponte bot → Segfy:
 *   - mapearDadosParaSegfy: coerção pura de tipos (sem I/O).
 *   - dispararCotacaoSegfy: no-op (null) quando SEGFY_ENABLED=false — prova de
 *     não-impacto (a flag desligada não toca Supabase nem o SegfyClient).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mapearDadosParaSegfy, dispararCotacaoSegfy } from "../src/services/segfy-cotacao.service";
import { _resetEnvCache } from "../src/config/env";

function envMinimo(extra: Record<string, string> = {}): void {
  // Desliga integrações que exigem credenciais no superRefine do env.
  process.env.WA_ENABLED = "false";
  process.env.BIA_ENABLED = "false";
  process.env.SEGFY_ENABLED = "false";
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
  _resetEnvCache();
}

describe("mapearDadosParaSegfy", () => {
  it("coage strings numéricas e booleanas e mantém o nome", () => {
    const r = mapearDadosParaSegfy({
      nome: "  Humberto ",
      ano_modelo: "2022",
      ano_fabricacao: 2021,
      bonus_atual: "5",
      comissao_percentual: "15",
      alienado: "nao",
      zero_km: "sim",
      uso_veiculo: "particular",
      cpf: "123",
    });
    expect(r.nome).toBe("Humberto");
    expect(r.ano_modelo).toBe(2022);
    expect(r.ano_fabricacao).toBe(2021);
    expect(r.bonus_atual).toBe(5);
    expect(r.comissao_percentual).toBe(15);
    expect(r.alienado).toBe(false);
    expect(r.zero_km).toBe(true);
    expect(r.uso_veiculo).toBe("particular");
  });

  it("campos ausentes viram undefined (nome vira string vazia)", () => {
    const r = mapearDadosParaSegfy({});
    expect(r.nome).toBe("");
    expect(r.cpf).toBeUndefined();
    expect(r.ano_modelo).toBeUndefined();
    expect(r.alienado).toBeUndefined();
  });
});

describe("dispararCotacaoSegfy", () => {
  beforeEach(() => envMinimo());

  it("retorna null sem efeitos quando SEGFY_ENABLED=false", async () => {
    const r = await dispararCotacaoSegfy({
      conversaId: "conv_1",
      clienteId: "cli_1",
      dados: { nome: "Demo" },
    });
    expect(r).toBeNull();
  });
});
