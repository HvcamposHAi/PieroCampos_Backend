import { describe, it, expect } from "vitest";
import { comRetry, ehRetentavel, ErroHttp, CircuitBreaker } from "./resiliencia";

const noop = async (): Promise<void> => {};

describe("ehRetentavel", () => {
  it("4xx (exceto 429) não retenta; 429/5xx/rede retentam", () => {
    expect(ehRetentavel(new ErroHttp(400))).toBe(false);
    expect(ehRetentavel(new ErroHttp(404))).toBe(false);
    expect(ehRetentavel(new ErroHttp(429))).toBe(true);
    expect(ehRetentavel(new ErroHttp(503))).toBe(true);
    expect(ehRetentavel(new Error("timeout"))).toBe(true);
  });
});

describe("comRetry", () => {
  it("retenta até obter sucesso", async () => {
    let n = 0;
    const r = await comRetry(
      async () => {
        n += 1;
        if (n < 3) throw new ErroHttp(500);
        return "ok";
      },
      { maxRetries: 5, baseMs: 1, sleep: noop, rand: () => 0 },
    );
    expect(r).toBe("ok");
    expect(n).toBe(3);
  });

  it("fail-fast em 4xx", async () => {
    let n = 0;
    await expect(
      comRetry(
        async () => {
          n += 1;
          throw new ErroHttp(400);
        },
        { maxRetries: 5, baseMs: 1, sleep: noop, rand: () => 0 },
      ),
    ).rejects.toBeInstanceOf(ErroHttp);
    expect(n).toBe(1);
  });
});

describe("CircuitBreaker", () => {
  it("abre após exceder o limiar e fecha após cooldown", () => {
    let t = 0;
    const cb = new CircuitBreaker({ limiarFalha: 0.5, minAmostras: 2, cooldownMs: 100, agora: () => t });
    cb.falha("k");
    cb.falha("k");
    expect(cb.aberto("k")).toBe(true); // 100% falha em 2 amostras → aberto
    t = 150; // passou o cooldown
    expect(cb.aberto("k")).toBe(false); // meio-aberto deixa passar
    cb.sucesso("k");
    expect(cb.aberto("k")).toBe(false);
  });
});
