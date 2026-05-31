// Validação de CPF para a edição do cadastro do cliente (clientes.cpf).
import { describe, it, expect } from "vitest";
import { cpfValido, formatarCpf } from "../src/integrations/whatsapp/conversas.dados";

describe("cpfValido", () => {
  it("aceita CPF válido (com ou sem máscara)", () => {
    expect(cpfValido("529.982.247-25")).toBe(true);
    expect(cpfValido("52998224725")).toBe(true);
  });

  it("rejeita o placeholder 000.000.000-00 e repetidos", () => {
    expect(cpfValido("000.000.000-00")).toBe(false);
    expect(cpfValido("111.111.111-11")).toBe(false);
  });

  it("rejeita dígitos verificadores errados e comprimento inválido", () => {
    expect(cpfValido("529.982.247-24")).toBe(false); // último dígito errado
    expect(cpfValido("123")).toBe(false);
    expect(cpfValido("")).toBe(false);
  });
});

describe("formatarCpf", () => {
  it("formata 11 dígitos como 000.000.000-00", () => {
    expect(formatarCpf("52998224725")).toBe("529.982.247-25");
    expect(formatarCpf("529.982.247-25")).toBe("529.982.247-25");
  });
});
