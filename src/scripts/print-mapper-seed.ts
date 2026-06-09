/**
 * Imprime o SQL de SEED do mapeamento dinâmico (auto/Segfy) — Cláusula 7 do
 * plano. READ-ONLY: não toca o banco; só gera os INSERT para o usuário colar
 * após aplicar as cláusulas 1-6. Idempotente (ON CONFLICT DO NOTHING).
 *
 *   npm run mapper:seed
 *
 * As regras nascem `seed/ativo` → o mapper dinâmico reproduz o hardcoded.
 */
import { buildSeedSegfyAuto } from "../integrations/quote/mapper/seed-segfy-auto";

function sqlText(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function main(): void {
  const { schema, rules } = buildSeedSegfyAuto();
  const linhas: string[] = [];

  linhas.push("-- ===== SEED: mapeamento dinâmico (provider=segfy, ramo=auto) =====");
  linhas.push("-- Schema default global (corretora_id NULL).");
  linhas.push(
    "INSERT INTO public.quote_provider_schema (corretora_id, provider, ramo, campos, versao)",
  );
  linhas.push(
    `VALUES (NULL, ${sqlText(schema.provider)}, ${sqlText(schema.ramo)}, $json$${JSON.stringify(
      schema.campos,
    )}$json$::jsonb, ${schema.versao})`,
  );
  linhas.push("ON CONFLICT DO NOTHING;");
  linhas.push("");

  linhas.push(`-- Regras de seed (${rules.length}) — origem='seed', status='ativo'.`);
  linhas.push(
    "INSERT INTO public.quote_mapping_rule (corretora_id, provider, ramo, chave_alvo, entrada_normalizada, valor_resolvido, origem, status, confianca) VALUES",
  );
  const values = rules.map(
    (r) =>
      `  (NULL, ${sqlText(schema.provider)}, ${sqlText(schema.ramo)}, ${sqlText(r.chaveAlvo)}, ${sqlText(
        r.entradaNormalizada,
      )}, ${sqlText(r.valorResolvido)}, 'seed', 'ativo', ${r.confianca})`,
  );
  linhas.push(values.join(",\n"));
  linhas.push("ON CONFLICT DO NOTHING;");
  linhas.push("");

  // eslint-disable-next-line no-console
  console.log(linhas.join("\n"));
}

main();
