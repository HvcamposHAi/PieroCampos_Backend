/**
 * AES-256-GCM para cifrar o estado de autenticação do Baileys antes de gravar
 * em public.wa_auth_state. A chave (32 bytes) vem de WA_AUTH_ENCRYPTION_KEY,
 * que NUNCA é commitada — só vive no Render como secret e no .env local.
 *
 * Por que GCM: autenticado (tag verifica integridade). Manipular o ciphertext
 * sem a chave é detectado e levanta exception — não tentamos abrir a sessão
 * com creds adulteradas (marca canal em status='erro' lá em cima).
 *
 * Cada chamada de cifrar() usa um IV aleatório de 12 bytes (recomendação NIST).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getEnv } from "../../config/env";

const ALG = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface PayloadCifrado {
  iv: string;
  tag: string;
  ciphertext: string;
}

let cacheChave: Buffer | null = null;

function carregarChave(): Buffer {
  if (cacheChave) return cacheChave;
  const raw = getEnv().WA_AUTH_ENCRYPTION_KEY;
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `WA_AUTH_ENCRYPTION_KEY inválida: esperado ${KEY_BYTES} bytes em base64, recebido ${buf.length}.`,
    );
  }
  cacheChave = buf;
  return buf;
}

/** Cifra um valor JSON-serializável; devolve {iv, tag, ciphertext} em base64. */
export function cifrar(valor: unknown): PayloadCifrado {
  const chave = carregarChave();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, chave, iv);
  const plain = Buffer.from(JSON.stringify(valor), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/** Decifra; lança se a tag não bater (creds corrompidas → re-pareamento). */
export function decifrar<T = unknown>(payload: PayloadCifrado): T {
  const chave = carregarChave();
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const decipher = createDecipheriv(ALG, chave, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as T;
}

/** Reseta o cache da chave (uso em testes). */
export function _resetCipherCache(): void {
  cacheChave = null;
}
