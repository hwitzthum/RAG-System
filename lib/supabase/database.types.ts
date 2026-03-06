export type SupportedLanguage = "EN" | "DE" | "FR" | "IT" | "ES";
export type DocumentStatus = "queued" | "processing" | "ready" | "failed";
export type IngestionJobStatus = "queued" | "processing" | "completed" | "failed" | "dead_letter";

export type Database = {
  public: {
    Tables: {
      documents: {
        Row: {
          id: string;
          storage_path: string;
          sha256: string;
          title: string | null;
          language: SupportedLanguage | null;
          status: DocumentStatus;
          ingestion_version: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          storage_path: string;
          sha256: string;
          title?: string | null;
          language?: SupportedLanguage | null;
          status?: DocumentStatus;
          ingestion_version?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          storage_path?: string;
          sha256?: string;
          title?: string | null;
          language?: SupportedLanguage | null;
          status?: DocumentStatus;
          ingestion_version?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      document_chunks: {
        Row: {
          id: string;
          document_id: string;
          chunk_index: number;
          page_number: number;
          section_title: string | null;
          content: string;
          context: string;
          language: SupportedLanguage;
          embedding: number[];
          tsv: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          document_id: string;
          chunk_index: number;
          page_number: number;
          section_title?: string | null;
          content: string;
          context: string;
          language: SupportedLanguage;
          embedding: number[];
          tsv?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          document_id?: string;
          chunk_index?: number;
          page_number?: number;
          section_title?: string | null;
          content?: string;
          context?: string;
          language?: SupportedLanguage;
          embedding?: number[];
          tsv?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      ingestion_jobs: {
        Row: {
          id: string;
          document_id: string;
          status: IngestionJobStatus;
          attempt: number;
          last_error: string | null;
          idempotency_key: string | null;
          locked_at: string | null;
          locked_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          document_id: string;
          status?: IngestionJobStatus;
          attempt?: number;
          last_error?: string | null;
          idempotency_key?: string | null;
          locked_at?: string | null;
          locked_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          document_id?: string;
          status?: IngestionJobStatus;
          attempt?: number;
          last_error?: string | null;
          idempotency_key?: string | null;
          locked_at?: string | null;
          locked_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      retrieval_cache: {
        Row: {
          cache_key: string;
          normalized_query: string;
          language: SupportedLanguage;
          retrieval_version: number;
          chunk_ids: string[];
          payload: Record<string, unknown>;
          hit_count: number;
          created_at: string;
          expires_at: string;
          last_accessed_at: string;
        };
        Insert: {
          cache_key: string;
          normalized_query: string;
          language: SupportedLanguage;
          retrieval_version: number;
          chunk_ids?: string[];
          payload?: Record<string, unknown>;
          hit_count?: number;
          created_at?: string;
          expires_at: string;
          last_accessed_at?: string;
        };
        Update: {
          cache_key?: string;
          normalized_query?: string;
          language?: SupportedLanguage;
          retrieval_version?: number;
          chunk_ids?: string[];
          payload?: Record<string, unknown>;
          hit_count?: number;
          created_at?: string;
          expires_at?: string;
          last_accessed_at?: string;
        };
        Relationships: [];
      };
      query_history: {
        Row: {
          id: string;
          user_id: string;
          conversation_id: string | null;
          query: string;
          answer: string;
          citations: Array<Record<string, unknown>>;
          latency_ms: number;
          cache_hit: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          conversation_id?: string | null;
          query: string;
          answer: string;
          citations?: Array<Record<string, unknown>>;
          latency_ms: number;
          cache_hit?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          conversation_id?: string | null;
          query?: string;
          answer?: string;
          citations?: Array<Record<string, unknown>>;
          latency_ms?: number;
          cache_hit?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };
      user_openai_keys: {
        Row: {
          user_id: string;
          encrypted_key: string;
          iv: string;
          auth_tag: string;
          key_version: number;
          key_last4: string;
          key_fingerprint: string;
          created_at: string;
          updated_at: string;
          last_used_at: string | null;
        };
        Insert: {
          user_id: string;
          encrypted_key: string;
          iv: string;
          auth_tag: string;
          key_version?: number;
          key_last4: string;
          key_fingerprint: string;
          created_at?: string;
          updated_at?: string;
          last_used_at?: string | null;
        };
        Update: {
          user_id?: string;
          encrypted_key?: string;
          iv?: string;
          auth_tag?: string;
          key_version?: number;
          key_last4?: string;
          key_fingerprint?: string;
          created_at?: string;
          updated_at?: string;
          last_used_at?: string | null;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      match_document_chunks: {
        Args: {
          query_embedding: number[];
          match_count?: number;
          filter_language?: SupportedLanguage | null;
        };
        Returns: {
          chunk_id: string;
          document_id: string;
          page_number: number;
          section_title: string | null;
          content: string;
          context: string;
          language: SupportedLanguage;
          similarity: number;
        }[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
