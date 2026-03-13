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
          current_stage: string | null;
          stage_updated_at: string | null;
          processing_started_at: string | null;
          processing_duration_ms: number | null;
          chunk_candidates: Record<string, unknown>[] | null;
          chunks_total: number;
          chunks_processed: number;
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
          current_stage?: string | null;
          stage_updated_at?: string | null;
          processing_started_at?: string | null;
          processing_duration_ms?: number | null;
          chunk_candidates?: Record<string, unknown>[] | null;
          chunks_total?: number;
          chunks_processed?: number;
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
          current_stage?: string | null;
          stage_updated_at?: string | null;
          processing_started_at?: string | null;
          processing_duration_ms?: number | null;
          chunk_candidates?: Record<string, unknown>[] | null;
          chunks_total?: number;
          chunks_processed?: number;
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
    Views: {
      document_effective_statuses: {
        Row: {
          document_id: string;
          title: string | null;
          storage_path: string;
          sha256: string;
          language: SupportedLanguage | null;
          raw_document_status: DocumentStatus;
          ingestion_version: number;
          created_at: string;
          updated_at: string;
          latest_job_id: string | null;
          latest_job_status: IngestionJobStatus | null;
          latest_job_attempt: number | null;
          latest_job_last_error: string | null;
          latest_job_locked_at: string | null;
          latest_job_locked_by: string | null;
          latest_job_current_stage: string | null;
          latest_job_stage_updated_at: string | null;
          latest_job_chunks_processed: number | null;
          latest_job_chunks_total: number | null;
          latest_job_processing_duration_ms: number | null;
          latest_job_created_at: string | null;
          latest_job_updated_at: string | null;
          chunk_count: number;
          effective_status: DocumentStatus;
        };
        Relationships: [];
      };
    };
    Functions: {
      claim_ingestion_jobs: {
        Args: {
          worker_name: string;
          batch_size?: number;
          lock_timeout_seconds?: number;
          max_retries?: number;
        };
        Returns: {
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
        }[];
      };
      check_required_ingestion_rpcs: {
        Args: {
          required_functions?: string[] | null;
        };
        Returns: {
          function_name: string;
          is_present: boolean;
        }[];
      };
      smoke_test_ingestion_runtime_contract: {
        Args: Record<PropertyKey, never>;
        Returns: {
          check_name: string;
          detail: string;
        }[];
      };
      create_document_with_ingestion_job: {
        Args: {
          target_storage_path: string;
          target_sha256: string;
          target_title?: string | null;
          target_language?: SupportedLanguage | null;
        };
        Returns: {
          document_id: string;
          ingestion_job_id: string;
          document_status: DocumentStatus;
          job_status: IngestionJobStatus;
          ingestion_version: number;
          storage_path: string;
          sha256: string;
          idempotency_key: string;
          created_at: string;
        }[];
      };
      delete_document_cascade: {
        Args: {
          target_document_id: string;
        };
        Returns: {
          document_id: string;
          storage_path: string | null;
          deleted_job_count: number;
          deleted_chunk_count: number;
        }[];
      };
      replace_document_chunks: {
        Args: {
          target_document_id: string;
          target_chunks?: Record<string, unknown> | Record<string, unknown>[] | null;
        };
        Returns: {
          document_id: string;
          deleted_chunk_count: number;
          inserted_chunk_count: number;
        }[];
      };
      append_document_chunks: {
        Args: {
          target_document_id: string;
          target_chunks?: Record<string, unknown> | Record<string, unknown>[] | null;
        };
        Returns: {
          document_id: string;
          inserted_chunk_count: number;
        }[];
      };
      upsert_retrieval_cache_entry: {
        Args: {
          target_cache_key: string;
          target_normalized_query: string;
          target_language: SupportedLanguage;
          target_retrieval_version: number;
          target_chunk_ids?: string[] | null;
          target_payload?: Record<string, unknown> | null;
          target_expires_at?: string;
          target_created_at?: string;
          target_last_accessed_at?: string;
        };
        Returns: {
          cache_key: string;
          retrieval_version: number;
          expires_at: string;
          last_accessed_at: string;
        }[];
      };
      touch_retrieval_cache_entry: {
        Args: {
          target_cache_key: string;
          target_retrieval_version: number;
          target_last_accessed_at?: string;
        };
        Returns: {
          cache_key: string;
          hit_count: number;
          last_accessed_at: string;
        }[];
      };
      prune_retrieval_cache_entries: {
        Args: {
          target_current_retrieval_version: number;
          target_now?: string;
        };
        Returns: {
          expired_deleted_count: number;
          stale_version_deleted_count: number;
        }[];
      };
      invalidate_retrieval_cache: {
        Args: Record<PropertyKey, never>;
        Returns: {
          deleted_entry_count: number;
        }[];
      };
      ensure_document_queued_ingestion_job: {
        Args: {
          target_document_id: string;
        };
        Returns: {
          document_id: string;
          ingestion_job_id: string;
          document_status: DocumentStatus;
          job_status: IngestionJobStatus;
          ingestion_version: number;
          storage_path: string;
          sha256: string;
          idempotency_key: string;
          job_created: boolean;
          updated_at: string;
        }[];
      };
      complete_ingestion_job: {
        Args: {
          job_id: string;
          document_language?: SupportedLanguage | null;
        };
        Returns: {
          id: string;
          document_id: string;
          job_status: IngestionJobStatus;
          document_status: DocumentStatus;
          updated_at: string;
        }[];
      };
      fail_ingestion_job: {
        Args: {
          job_id: string;
          error_text: string;
          max_retries?: number;
        };
        Returns: {
          id: string;
          document_id: string;
          job_status: IngestionJobStatus;
          attempt: number;
          dead_letter: boolean;
          document_status: DocumentStatus;
          last_error: string;
          updated_at: string;
        }[];
      };
      requeue_dead_letter_document: {
        Args: {
          target_document_id: string;
        };
        Returns: {
          document_id: string;
          ingestion_job_id: string;
          document_status: DocumentStatus;
          job_status: IngestionJobStatus;
          ingestion_version: number;
          storage_path: string;
          sha256: string;
          idempotency_key: string;
          updated_at: string;
        }[];
      };
      reconcile_document_status: {
        Args: {
          target_document_id: string;
          expected_current_status: DocumentStatus;
          target_status: DocumentStatus;
        };
        Returns: {
          document_id: string;
          previous_status: DocumentStatus;
          document_status: DocumentStatus;
          updated_at: string;
        }[];
      };
      reconcile_ingestion_job_state: {
        Args: {
          target_job_id: string;
          expected_current_status: IngestionJobStatus;
          target_job_status: IngestionJobStatus;
          clear_lock?: boolean;
          target_document_status?: DocumentStatus | null;
          expected_document_current_status?: DocumentStatus | null;
        };
        Returns: {
          job_id: string;
          document_id: string;
          previous_job_status: IngestionJobStatus;
          job_status: IngestionJobStatus;
          document_status: DocumentStatus | null;
          updated_at: string;
        }[];
      };
      checkpoint_ingestion_job: {
        Args: {
          target_job_id: string;
          target_chunk_candidates?: Record<string, unknown>[] | null;
          target_chunks_total?: number | null;
          target_chunks_processed?: number | null;
          target_stage?: string | null;
        };
        Returns: {
          job_id: string;
          chunks_total: number;
          chunks_processed: number;
          current_stage: string | null;
          stage_updated_at: string | null;
          locked_at: string | null;
          updated_at: string;
        }[];
      };
      yield_ingestion_job: {
        Args: {
          target_job_id: string;
        };
        Returns: {
          job_id: string;
          job_status: IngestionJobStatus;
          attempt: number;
          current_stage: string | null;
          locked_at: string | null;
          locked_by: string | null;
          updated_at: string;
        }[];
      };
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
