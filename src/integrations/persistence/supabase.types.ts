/**
 * Tipo Database focado nas tabelas que o módulo Segfy realmente toca.
 *
 * Reflete o estado verificado do banco em produção (27/05/2026): tabelas e
 * colunas confirmadas via Bloco 0 contra o `types.ts` auto-gerado do frontend.
 * `segfy_sync_log` foi criada nas cláusulas de DDL deste plano.
 *
 * Mantemos um subconjunto para evitar sincronizar 1100+ linhas de tipos gerados;
 * se o adapter passar a usar mais tabelas, acrescente-as aqui.
 */

export type Json = string | number | boolean | null | { [k: string]: Json | undefined } | Json[];

export type StatusCotacao = "pendente" | "processando" | "concluida" | "erro" | "expirada";
export type EstadoCivil = "solteiro" | "casado" | "divorciado" | "viuvo" | "uniao_estavel";

export interface Database {
  public: {
    Tables: {
      clientes: {
        Row: {
          atendimento_vip: boolean;
          atualizado_em: string;
          cnpj: string | null;
          consentimento_em: string | null;
          consentimento_lgpd: boolean;
          cpf: string | null;
          criado_em: string;
          data_nascimento: string | null;
          deletado_em: string | null;
          email: string | null;
          endereco: Json | null;
          estado_civil: EstadoCivil | null;
          id: string;
          nome: string | null;
          profissao: string | null;
          rg: string | null;
          segfy_id: string | null;
          telefone: string;
        };
        Insert: {
          atendimento_vip?: boolean;
          consentimento_lgpd?: boolean;
          cpf?: string | null;
          email?: string | null;
          id?: string;
          nome?: string | null;
          segfy_id?: string | null;
          telefone: string;
        };
        Update: {
          segfy_id?: string | null;
          consentimento_lgpd?: boolean;
          consentimento_em?: string | null;
        };
        Relationships: [];
      };
      cotacoes: {
        Row: {
          aceito_em: string | null;
          aceito_plano: Json | null;
          aceito_seguradora: string | null;
          atualizado_em: string;
          bonus_atual: number | null;
          cliente_id: string;
          comissao_percentual: number | null;
          conversa_id: string | null;
          criado_em: string;
          dados_entrada: Json;
          id: string;
          origem: string;
          ramo: string;
          renovacao_outro_corretor: boolean | null;
          resultados: Json | null;
          segfy_cotacao_id: string | null;
          seguradora_anterior: string | null;
          status: StatusCotacao;
          validade_ate: string | null;
        };
        Insert: {
          cliente_id: string;
          conversa_id?: string | null;
          dados_entrada?: Json;
          id?: string;
          origem?: string;
          ramo: string;
          resultados?: Json | null;
          segfy_cotacao_id?: string | null;
          status?: StatusCotacao;
          validade_ate?: string | null;
        };
        Update: {
          status?: StatusCotacao;
          resultados?: Json | null;
        };
        Relationships: [];
      };
      segfy_sync_log: {
        Row: {
          criado_em: string;
          detalhe: Json | null;
          id: string;
          operacao: string;
          ref_id: string | null;
          sucesso: boolean;
          via: string;
        };
        Insert: {
          criado_em?: string;
          detalhe?: Json | null;
          id?: string;
          operacao: string;
          ref_id?: string | null;
          sucesso: boolean;
          via: string;
        };
        Update: {
          detalhe?: Json | null;
        };
        Relationships: [];
      };
      cotacao_eventos: {
        Row: {
          id: string;
          cotacao_id: string | null;
          conversa_id: string | null;
          etapa: string;
          status: string;
          mensagem: string | null;
          detalhe: Json | null;
          criado_em: string;
        };
        Insert: {
          id?: string;
          cotacao_id?: string | null;
          conversa_id?: string | null;
          etapa: string;
          status: string;
          mensagem?: string | null;
          detalhe?: Json | null;
          criado_em?: string;
        };
        Update: {
          status?: string;
          mensagem?: string | null;
          detalhe?: Json | null;
        };
        Relationships: [];
      };
      // ── Descoberta & Forja de Integrações (ADI) — cláusulas A–D ──────────
      pagina_contrato: {
        Row: {
          id: string;
          corretora_id: string;
          sistema: string;
          ramo: string;
          operacao: string;
          url_base: string | null;
          versao: number;
          openapi: Json;
          premissas: Json;
          ramos_disponiveis: Json;
          seguranca: Json;
          fluxo: Json;
          status: string;
          aprovado_por: string | null;
          aprovado_em: string | null;
          criado_em: string;
          atualizado_em: string;
        };
        Insert: {
          id?: string;
          corretora_id: string;
          sistema: string;
          ramo: string;
          operacao?: string;
          url_base?: string | null;
          versao?: number;
          openapi?: Json;
          premissas?: Json;
          ramos_disponiveis?: Json;
          seguranca?: Json;
          fluxo?: Json;
          status?: string;
          aprovado_por?: string | null;
          aprovado_em?: string | null;
        };
        Update: {
          openapi?: Json;
          premissas?: Json;
          ramos_disponiveis?: Json;
          seguranca?: Json;
          fluxo?: Json;
          status?: string;
          aprovado_por?: string | null;
          aprovado_em?: string | null;
          atualizado_em?: string;
        };
        Relationships: [];
      };
      adapter_spec: {
        Row: {
          id: string;
          corretora_id: string;
          contrato_id: string;
          sistema: string;
          seguradora_config_id: string | null;
          ramo: string;
          operacao: string;
          objetivo: string;
          caso_teste: Json | null;
          criterio_sucesso: Json | null;
          spec: Json;
          versao: number;
          ativo: boolean;
          status: string;
          criado_em: string;
          atualizado_em: string;
        };
        Insert: {
          id?: string;
          corretora_id: string;
          contrato_id: string;
          sistema: string;
          ramo: string;
          operacao?: string;
          spec: Json;
          versao?: number;
          ativo?: boolean;
          status?: string;
        };
        Update: {
          spec?: Json;
          ativo?: boolean;
          status?: string;
          atualizado_em?: string;
        };
        Relationships: [];
      };
      descoberta_execucao: {
        Row: {
          id: string;
          corretora_id: string;
          contrato_id: string | null;
          sistema: string;
          ramo: string | null;
          tipo: string;
          status: string;
          etapa: string | null;
          har_ref: string | null;
          resumo: Json | null;
          custo_tokens: number | null;
          erro: string | null;
          criado_em: string;
        };
        Insert: {
          id?: string;
          corretora_id: string;
          contrato_id?: string | null;
          sistema: string;
          ramo?: string | null;
          tipo?: string;
          status?: string;
          etapa?: string | null;
          har_ref?: string | null;
          resumo?: Json | null;
          custo_tokens?: number | null;
          erro?: string | null;
        };
        Update: {
          status?: string;
          etapa?: string | null;
          resumo?: Json | null;
          erro?: string | null;
        };
        Relationships: [];
      };
      descoberta_config: {
        Row: {
          corretora_id: string;
          exec_ativo: boolean;
          atualizado_em: string;
          atualizado_por: string | null;
        };
        Insert: {
          corretora_id: string;
          exec_ativo?: boolean;
          atualizado_por?: string | null;
        };
        Update: {
          exec_ativo?: boolean;
          atualizado_por?: string | null;
          atualizado_em?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: { status_cotacao: StatusCotacao; estado_civil: EstadoCivil };
    CompositeTypes: Record<string, never>;
  };
}
