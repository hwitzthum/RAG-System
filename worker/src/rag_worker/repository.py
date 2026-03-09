from datetime import datetime, timedelta, timezone
from logging import Logger
from typing import TYPE_CHECKING, Any

from rag_worker.config import WorkerSettings
from rag_worker.types import DocumentRecord, IngestionJob, PreparedChunkRecord

if TYPE_CHECKING:
    from supabase import Client
else:  # pragma: no cover - static typing fallback
    Client = Any


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stale_lock_cutoff_iso(timeout_seconds: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=timeout_seconds)).isoformat()


def _safe_str(value: object) -> str:
    return str(value) if value is not None else ""


class WorkerRepository:
    def __init__(self, settings: WorkerSettings, logger: Logger) -> None:
        self.settings = settings
        self.logger = logger
        self.client: Client = self._create_client(settings.supabase_url, settings.supabase_service_role_key)

    @staticmethod
    def _create_client(url: str, service_role_key: str) -> Client:
        try:
            from supabase import create_client
        except ModuleNotFoundError as exc:  # pragma: no cover - runtime environment error
            raise RuntimeError("supabase package is required to run the ingestion worker") from exc

        return create_client(url, service_role_key)

    def claim_next_job(self) -> IngestionJob | None:
        response = (
            self.client.table("ingestion_jobs")
            .select("id,document_id,status,attempt")
            .in_("status", ["queued", "failed"])
            .lt("attempt", self.settings.max_retries)
            .is_("locked_at", "null")
            .order("created_at", desc=False)
            .limit(10)
            .execute()
        )

        for row in response.data or []:
            claimed = (
                self.client.table("ingestion_jobs")
                .update(
                    {
                        "status": "processing",
                        "attempt": int(row["attempt"]) + 1,
                        "locked_at": _utc_now_iso(),
                        "locked_by": self.settings.worker_name,
                    }
                )
                .eq("id", row["id"])
                .eq("status", row["status"])
                .is_("locked_at", "null")
                .execute()
            )

            if claimed.data:
                selected = claimed.data[0]
                return IngestionJob(
                    id=_safe_str(selected["id"]),
                    document_id=_safe_str(selected["document_id"]),
                    status=_safe_str(selected["status"]),
                    attempt=int(selected["attempt"]),
                )

        if self.settings.worker_lock_timeout_seconds <= 0:
            return None

        stale_cutoff = _stale_lock_cutoff_iso(self.settings.worker_lock_timeout_seconds)
        stale_response = (
            self.client.table("ingestion_jobs")
            .select("id,document_id,status,attempt")
            .eq("status", "processing")
            .lt("attempt", self.settings.max_retries)
            .lte("locked_at", stale_cutoff)
            .order("locked_at", desc=False)
            .limit(10)
            .execute()
        )

        for row in stale_response.data or []:
            reclaimed = (
                self.client.table("ingestion_jobs")
                .update(
                    {
                        "status": "processing",
                        "attempt": int(row["attempt"]) + 1,
                        "locked_at": _utc_now_iso(),
                        "locked_by": self.settings.worker_name,
                    }
                )
                .eq("id", row["id"])
                .eq("status", "processing")
                .lte("locked_at", stale_cutoff)
                .execute()
            )

            if reclaimed.data:
                selected = reclaimed.data[0]
                self.logger.warning(
                    "reclaimed_stale_job_lock",
                    extra={
                        "job_id": _safe_str(selected["id"]),
                        "document_id": _safe_str(selected["document_id"]),
                    },
                )
                return IngestionJob(
                    id=_safe_str(selected["id"]),
                    document_id=_safe_str(selected["document_id"]),
                    status=_safe_str(selected["status"]),
                    attempt=int(selected["attempt"]),
                )

        return None

    def get_document(self, document_id: str) -> DocumentRecord:
        response = (
            self.client.table("documents")
            .select("id,storage_path,sha256,title,language,status,ingestion_version")
            .eq("id", document_id)
            .single()
            .execute()
        )

        data = response.data
        if not data:
            raise RuntimeError(f"Document not found: {document_id}")

        language_value = data.get("language")
        if isinstance(language_value, str) and language_value in {"EN", "DE", "FR", "IT", "ES"}:
            language = language_value
        else:
            language = None

        return DocumentRecord(
            id=_safe_str(data["id"]),
            storage_path=_safe_str(data["storage_path"]),
            sha256=_safe_str(data["sha256"]),
            title=data.get("title"),
            language=language,
            status=_safe_str(data["status"]),
            ingestion_version=int(data["ingestion_version"]),
        )

    def download_document(self, storage_path: str) -> bytes:
        payload = self.client.storage.from_(self.settings.rag_storage_bucket).download(storage_path)
        if isinstance(payload, bytes):
            return payload
        if hasattr(payload, "content"):
            return payload.content  # type: ignore[return-value]
        raise RuntimeError("Unexpected storage download payload")

    def set_document_status(self, document_id: str, status: str, language: str | None = None) -> None:
        update_payload: dict[str, object] = {"status": status}
        if language:
            update_payload["language"] = language

        self.client.table("documents").update(update_payload).eq("id", document_id).execute()

    def replace_document_chunks(self, document_id: str, chunks: list[PreparedChunkRecord]) -> None:
        self.client.table("document_chunks").delete().eq("document_id", document_id).execute()

        if not chunks:
            return

        batch_size = max(1, self.settings.worker_chunk_insert_batch_size)

        for index in range(0, len(chunks), batch_size):
            batch = chunks[index : index + batch_size]
            rows = [
                {
                    "document_id": item.document_id,
                    "chunk_index": item.chunk_index,
                    "page_number": item.page_number,
                    "section_title": item.section_title,
                    "content": item.content,
                    "context": item.context,
                    "language": item.language,
                    "embedding": item.embedding,
                }
                for item in batch
            ]
            self.client.table("document_chunks").insert(rows).execute()

    def mark_job_completed(self, job_id: str) -> None:
        (
            self.client.table("ingestion_jobs")
            .update(
                {
                    "status": "completed",
                    "last_error": None,
                    "locked_at": None,
                    "locked_by": None,
                }
            )
            .eq("id", job_id)
            .execute()
        )

    def mark_job_failed(self, job: IngestionJob, error_message: str) -> bool:
        dead_letter = job.attempt >= self.settings.max_retries
        status = "dead_letter" if dead_letter else "failed"

        (
            self.client.table("ingestion_jobs")
            .update(
                {
                    "status": status,
                    "last_error": error_message[:4000],
                    "locked_at": None,
                    "locked_by": None,
                }
            )
            .eq("id", job.id)
            .execute()
        )

        return dead_letter
