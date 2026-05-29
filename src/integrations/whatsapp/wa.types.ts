/**
 * Tipos das tabelas que o módulo WhatsApp lê/escreve.
 *
 * Subset minimal — espelhamos do schema real (ver migration
 * piero-broker-assist/supabase/migrations/20260528120000_wa_baileys.sql).
 * Nada aqui é gerado automaticamente; ajuste manual quando a migration mudar.
 */

export type Json = string | number | boolean | null | { [k: string]: Json | undefined } | Json[];

export type StatusCanal =
  | "desconectado"
  | "conectando"
  | "aguardando_qr"
  | "conectado"
  | "erro"
  | "banido";

export interface CanalRow {
  id: string;
  apelido: string;
  ativo: boolean;
  provider: string;
  status: StatusCanal;
  numero_e164: string | null;
  numero_twilio: string | null;
  display_name: string | null;
  qr_code: string | null;
  qr_expires_at: string | null;
  last_connected_at: string | null;
  last_disconnect_reason: string | null;
}

export interface CanalUpdate {
  status?: StatusCanal;
  qr_code?: string | null;
  qr_expires_at?: string | null;
  numero_e164?: string | null;
  display_name?: string | null;
  last_connected_at?: string | null;
  last_disconnect_reason?: string | null;
}

export interface WaAuthStateRow {
  canal_id: string;
  key: string;
  value: Json;
  updated_at: string;
}

export interface ClienteRow {
  id: string;
  telefone: string;
  nome: string | null;
}

export interface ConversaRow {
  id: string;
  canal_id: string;
  cliente_id: string;
  estado: string;
}

export interface MensagemInsert {
  conversa_id: string;
  direcao: "entrada" | "saida";
  origem: "cliente" | "bot" | "operador";
  corpo?: string | null;
  midia_url?: string | null;
  midia_tipo?: string | null;
  // Coluna em prod é `twilio_message_sid` (não `twilio_sid`). Reaproveitamos
  // como id do provider (Baileys); renomear no futuro.
  twilio_message_sid?: string | null;
  enviada_em?: string;
}
