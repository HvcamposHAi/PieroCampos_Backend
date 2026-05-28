/**
 * AuthenticationState do Baileys lendo/escrevendo em public.wa_auth_state.
 *
 * Substitui o useMultiFileAuthState do Baileys (que grava em arquivos locais)
 * por persistência cifrada no Supabase — assim Render restart / migração de
 * host não perde a sessão. Cada canal tem suas próprias chaves identificadas
 * por canal_id; um (canal_id, key) é PK composta.
 *
 * O Baileys usa Buffer cru dentro das creds; precisamos passar pelo
 * BufferJSON.replacer/reviver antes/depois de cifrar para não corromper.
 */
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import { logger } from "../../utils/logger";
import { cifrar, decifrar, type PayloadCifrado } from "./cipher";
import { getSupabaseAdmin } from "./supabase";
import type { Json } from "./wa.types";

function preparar(valor: unknown): unknown {
  // BufferJSON.replacer converte Buffer/Uint8Array para {type:'Buffer',data:[]}
  return JSON.parse(JSON.stringify(valor, BufferJSON.replacer));
}

function restaurar<T = unknown>(valor: unknown): T {
  // BufferJSON.reviver reconstrói Buffer a partir da forma plana.
  return JSON.parse(JSON.stringify(valor), BufferJSON.reviver) as T;
}

async function ler(canalId: string, key: string): Promise<unknown | null> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("wa_auth_state")
    .select("value")
    .eq("canal_id", canalId)
    .eq("key", key)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  try {
    const decifrado = decifrar<unknown>(data.value as unknown as PayloadCifrado);
    return restaurar(decifrado);
  } catch (e) {
    // Tag inválida / chave trocada → não tentar abrir socket com creds quebradas.
    logger.error("[wa.authState] falha ao decifrar (creds corrompidas?)", {
      canalId,
      key,
      mensagem: (e as Error).message,
    });
    throw new Error("wa_auth_state_decrypt_failed");
  }
}

async function escrever(canalId: string, key: string, valor: unknown): Promise<void> {
  const sb = getSupabaseAdmin();
  const payload = cifrar(preparar(valor));
  const { error } = await sb.from("wa_auth_state").upsert(
    {
      canal_id: canalId,
      key,
      value: payload as unknown as Json,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "canal_id,key" },
  );
  if (error) throw error;
}

async function apagar(canalId: string, key: string): Promise<void> {
  const sb = getSupabaseAdmin();
  const { error } = await sb
    .from("wa_auth_state")
    .delete()
    .eq("canal_id", canalId)
    .eq("key", key);
  if (error) throw error;
}

/** Apaga TODAS as rows do canal — usado em logout remoto / re-pareamento. */
export async function apagarAuthState(canalId: string): Promise<void> {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("wa_auth_state").delete().eq("canal_id", canalId);
  if (error) throw error;
}

/** True se há pelo menos a row 'creds' para o canal. */
export async function temAuthState(canalId: string): Promise<boolean> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("wa_auth_state")
    .select("key")
    .eq("canal_id", canalId)
    .eq("key", "creds")
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

/**
 * Cria o AuthenticationState para o canal. Se já há creds salvas, reusa-as;
 * caso contrário, gera com initAuthCreds().
 */
export async function useSupabaseAuthState(canalId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const credsExistente = (await ler(canalId, "creds")) as AuthenticationCreds | null;
  const creds: AuthenticationCreds = credsExistente ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        async get(type, ids) {
          const result: { [id: string]: SignalDataTypeMap[typeof type] } = {};
          await Promise.all(
            ids.map(async (id) => {
              const valor = await ler(canalId, `keys:${type}:${id}`);
              if (valor) {
                let v = valor as SignalDataTypeMap[typeof type];
                if (type === "app-state-sync-key") {
                  v = proto.Message.AppStateSyncKeyData.fromObject(
                    valor as object,
                  ) as unknown as SignalDataTypeMap[typeof type];
                }
                result[id] = v;
              }
              // Chaves ausentes ficam fora do record — o contrato do Baileys
              // aceita "missing key" como undefined no acesso por índice; só não
              // expõe undefined no TIPO do retorno.
            }),
          );
          return result;
        },
        async set(data) {
          const tarefas: Promise<void>[] = [];
          for (const categoria of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
            const sub = data[categoria];
            if (!sub) continue;
            for (const id of Object.keys(sub)) {
              const valor = (sub as Record<string, unknown>)[id];
              const key = `keys:${categoria}:${id}`;
              if (valor) tarefas.push(escrever(canalId, key, valor));
              else tarefas.push(apagar(canalId, key));
            }
          }
          await Promise.all(tarefas);
        },
      },
    },
    saveCreds: async () => {
      await escrever(canalId, "creds", creds);
    },
  };
}
