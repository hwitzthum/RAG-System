from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class WorkerSettings(BaseSettings):
    """Environment-backed configuration for the ingestion worker."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    worker_name: str = Field(default="rag-ingestion-worker", alias="WORKER_NAME")
    poll_interval_seconds: int = Field(default=5, alias="WORKER_POLL_INTERVAL_SECONDS")
    max_retries: int = Field(default=3, alias="WORKER_MAX_RETRIES")

    supabase_url: str = Field(alias="SUPABASE_URL")
    supabase_service_role_key: str = Field(alias="SUPABASE_SERVICE_ROLE_KEY")
    rag_storage_bucket: str = Field(default="documents", alias="RAG_STORAGE_BUCKET")

    worker_chunk_target_tokens: int = Field(default=700, alias="WORKER_CHUNK_TARGET_TOKENS")
    worker_chunk_overlap_tokens: int = Field(default=120, alias="WORKER_CHUNK_OVERLAP_TOKENS")
    worker_chunk_min_chars: int = Field(default=120, alias="WORKER_CHUNK_MIN_CHARS")

    worker_context_model: str = Field(default="gpt-4o-mini", alias="WORKER_CONTEXT_MODEL")
    worker_context_enabled: bool = Field(default=True, alias="WORKER_CONTEXT_ENABLED")
    worker_context_max_chars: int = Field(default=280, alias="WORKER_CONTEXT_MAX_CHARS")

    worker_embedding_model: str = Field(default="text-embedding-3-small", alias="WORKER_EMBEDDING_MODEL")
    worker_embedding_dim: int = Field(default=1536, alias="WORKER_EMBEDDING_DIM")
    worker_embedding_batch_size: int = Field(default=32, alias="WORKER_EMBEDDING_BATCH_SIZE")

    worker_openai_timeout_seconds: int = Field(default=40, alias="WORKER_OPENAI_TIMEOUT_SECONDS")
    openai_api_key: str | None = Field(default=None, alias="OPENAI_API_KEY")

    worker_ocr_fallback_enabled: bool = Field(default=True, alias="WORKER_OCR_FALLBACK_ENABLED")
    worker_lock_timeout_seconds: int = Field(default=900, alias="WORKER_LOCK_TIMEOUT_SECONDS")
    worker_chunk_insert_batch_size: int = Field(default=100, alias="WORKER_CHUNK_INSERT_BATCH_SIZE")


@lru_cache(maxsize=1)
def get_settings() -> WorkerSettings:
    return WorkerSettings()
