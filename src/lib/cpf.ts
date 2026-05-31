/**
 * Validação e formatação de CPF — util puro, compartilhado entre a edição do
 * cadastro (conversas.dados) e o mapeamento da cotação (segfy-cotacao.service).
 */

/** Valida CPF: 11 dígitos + dígitos verificadores. Rejeita repetidos (000…00). */
export function cpfValido(bruto: string): boolean {
  const d = (bruto ?? "").replace(/\D/g, "");
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false; // todos iguais (placeholder)
  const dig = (fim: number): number => {
    let soma = 0;
    for (let i = 0; i < fim; i++) soma += Number(d[i]) * (fim + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dig(9) === Number(d[9]) && dig(10) === Number(d[10]);
}

/** Formata 11 dígitos como 000.000.000-00. */
export function formatarCpf(bruto: string): string {
  const d = (bruto ?? "").replace(/\D/g, "");
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9, 11)}`;
}
