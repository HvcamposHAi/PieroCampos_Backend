/**
 * Carga em massa das credenciais de portal por seguradora (cifradas).
 *
 * Lê um arquivo JSON **NÃO-VERSIONADO** (fora do repo) com as credenciais, cifra
 * cada usuário/senha/extra com cipher.ts (chave WA_AUTH_ENCRYPTION_KEY) e faz
 * upsert em `seguradora_credenciais` (service_role). Casa cada entrada com
 * `seguradoras_config` por `nome_display` + corretora. NUNCA loga valores.
 *
 * Uso (PowerShell):
 *   npx tsx src/scripts/seed-portais-credenciais.ts "C:/tmp/portais-credenciais.piero.json" [corretoraId]
 *
 * O JSON tem a forma:
 *   [{ "nome_display": "Porto Seguro", "usuario": "...", "senha": "...", "extra": { "susep": "..." } }, ...]
 * `senha`/`extra` são opcionais (ex.: portais só com código por e-mail).
 *
 * APAGUE o arquivo JSON após rodar — ele contém segredos em texto.
 */
import { readFileSync } from "node:fs";
import { cifrar } from "../integrations/whatsapp/cipher";
import { getSupabaseAdmin } from "../integrations/whatsapp/supabase";
import { CORRETORA_SEED_ID } from "../integrations/persistence/supabase-persistence";
import { logger } from "../utils/logger";

interface EntradaCred {
  nome_display: string;
  usuario: string;
  senha?: string;
  extra?: Record<string, string>;
}

async function main(): Promise<void> {
  const caminho = process.argv[2];
  const corretoraId = process.argv[3] ?? process.env.CORRETORA_SEED_ID ?? CORRETORA_SEED_ID;
  if (!caminho) {
    logger.error("[seed-cred] uso: tsx seed-portais-credenciais.ts <arquivo.json> [corretoraId]");
    process.exit(1);
  }

  const entradas = JSON.parse(readFileSync(caminho, "utf8")) as EntradaCred[];
  const sb = getSupabaseAdmin();

  // Mapa nome_display → id (escopo da corretora).
  const { data, error } = await sb
    .from("seguradoras_config")
    .select("id, nome_display")
    .eq("corretora_id" as never, corretoraId as never);
  if (error) throw new Error(`leitura de seguradoras_config falhou: ${error.message}`);
  const idPorNome = new Map<string, string>(
    (data as Array<{ id: string; nome_display: string }>).map((r) => [
      r.nome_display.trim().toLowerCase(),
      r.id,
    ]),
  );

  let ok = 0;
  const semCatalogo: string[] = [];
  for (const e of entradas) {
    const id = idPorNome.get(e.nome_display.trim().toLowerCase());
    if (!id) {
      semCatalogo.push(e.nome_display);
      continue;
    }
    const payload: Record<string, unknown> = {
      corretora_id: corretoraId,
      seguradora_config_id: id,
      usuario_cifrado: cifrar(e.usuario),
      senha_cifrada: e.senha ? cifrar(e.senha) : null,
      extra_cifrado: e.extra ? cifrar(e.extra) : null,
      atualizado_por: "seed-script",
      atualizado_em: new Date().toISOString(),
    };
    const { error: upErr } = await sb
      .from("seguradora_credenciais")
      .upsert(payload as never, { onConflict: "corretora_id,seguradora_config_id" });
    if (upErr) {
      logger.error("[seed-cred] upsert falhou", { nome: e.nome_display, codigo: upErr.message });
      continue;
    }
    ok++;
    logger.info("[seed-cred] credencial gravada (cifrada)", { nome: e.nome_display }); // sem valores
  }

  logger.info("[seed-cred] concluído", {
    gravadas: ok,
    total: entradas.length,
    sem_catalogo: semCatalogo,
  });
  if (semCatalogo.length) {
    logger.warn("[seed-cred] sem linha em seguradoras_config (rode a Cláusula D antes)", {
      nomes: semCatalogo,
    });
  }
}

main().catch((e) => {
  logger.error("[seed-cred] erro fatal", { erro: (e as Error).message });
  process.exit(1);
});
