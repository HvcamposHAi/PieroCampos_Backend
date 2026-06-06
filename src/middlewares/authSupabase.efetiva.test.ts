// corretoraEfetiva: super-admin usa a corretora "ativa" (a que entrou); demais
// usam a própria. Plataforma sem seleção → null (rotas de escrita devem barrar).
import { describe, it, expect } from "vitest";
import { corretoraEfetiva, type OperadorAtivo } from "./authSupabase";

function op(p: Partial<OperadorAtivo>): OperadorAtivo {
  return {
    id: "op",
    perfil: "admin",
    canal_padrao_id: null,
    corretora_id: "corr-propria",
    is_plataforma: false,
    corretora_ativa_id: null,
    ...p,
  };
}

describe("corretoraEfetiva", () => {
  it("operador normal → a própria corretora", () => {
    expect(corretoraEfetiva(op({ is_plataforma: false, corretora_id: "A" }))).toBe("A");
  });
  it("super-admin COM corretora ativa → a ativa", () => {
    expect(
      corretoraEfetiva(op({ is_plataforma: true, corretora_id: "seed", corretora_ativa_id: "B" })),
    ).toBe("B");
  });
  it("super-admin SEM seleção → null (ver todas / barrar escrita escopada)", () => {
    expect(
      corretoraEfetiva(op({ is_plataforma: true, corretora_id: "seed", corretora_ativa_id: null })),
    ).toBeNull();
  });
});
