/**
 * Validação/normalização de telefone BR para E.164. Usado quando o número vem do
 * cliente (bot perguntou) ou do operador (edição manual) — diferente do `wa_jid`,
 * que é o endereço de ENVIO. Aceita com/sem DDI 55 e com/sem o 9º dígito.
 */

/** Só os dígitos. */
function digitos(bruto: string): string {
  return (bruto ?? "").replace(/\D/g, "");
}

/**
 * Normaliza para E.164 BR (`+55DDDNNNNNNNNN`). Aceita:
 *   - 10/11 dígitos (DDD + número, com/sem 9) → prefixa 55;
 *   - 12/13 dígitos começando com 55 → mantém.
 * Retorna null se não for um celular/fixo BR plausível.
 */
export function normalizarTelefoneBr(bruto: string): string | null {
  let d = digitos(bruto);
  // remove zeros de discagem à esquerda (ex.: "0" + DDD); nenhum telefone BR começa com 0
  d = d.replace(/^0+/, "");
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) {
    // já tem DDI
  } else if (d.length === 10 || d.length === 11) {
    d = `55${d}`;
  } else {
    return null;
  }
  // Agora d = 55 + DDD(2) + assinante(8 ou 9). Valida DDD 11..99.
  const ddd = Number(d.slice(2, 4));
  if (!(ddd >= 11 && ddd <= 99)) return null;
  const assinante = d.slice(4);
  if (assinante.length !== 8 && assinante.length !== 9) return null;
  // Celular (9 dígitos) deve começar com 9.
  if (assinante.length === 9 && !assinante.startsWith("9")) return null;
  return `+${d}`;
}

/** true se `bruto` normaliza para um telefone BR válido em E.164. */
export function telefoneBrValido(bruto: string): boolean {
  return normalizarTelefoneBr(bruto) !== null;
}
