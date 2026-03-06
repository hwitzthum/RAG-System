import logging
import unittest
from unittest.mock import patch

from rag_worker.config import WorkerSettings
from rag_worker.pipeline import IngestionPipeline
from rag_worker.types import ChunkCandidate, DocumentRecord, ExtractedPage, IngestionJob, Section


class FakeRepository:
    def __init__(self) -> None:
        self.document = DocumentRecord(
            id="doc-1",
            storage_path="documents/doc-1.pdf",
            sha256="abc123",
            title="Test",
            language="EN",
            status="queued",
            ingestion_version=1,
        )
        self.status_updates: list[tuple[str, str, str | None]] = []
        self.replaced_chunks_history: list[list] = []
        self.completed_jobs: list[str] = []

    def get_document(self, document_id: str) -> DocumentRecord:
        if document_id != self.document.id:
            raise RuntimeError("Unexpected document id")
        return self.document

    def set_document_status(self, document_id: str, status: str, language: str | None = None) -> None:
        self.status_updates.append((document_id, status, language))

    def download_document(self, storage_path: str) -> bytes:
        if storage_path != self.document.storage_path:
            raise RuntimeError("Unexpected storage path")
        return b"%PDF-1.7 dummy payload"

    def replace_document_chunks(self, document_id: str, chunks: list) -> None:
        if document_id != self.document.id:
            raise RuntimeError("Unexpected document id")
        self.replaced_chunks_history.append(list(chunks))

    def mark_job_completed(self, job_id: str) -> None:
        self.completed_jobs.append(job_id)


def _make_settings() -> WorkerSettings:
    return WorkerSettings(
        SUPABASE_URL="https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY="service-role-key",
        OPENAI_API_KEY=None,
        WORKER_CONTEXT_ENABLED=False,
    )


class PipelineTests(unittest.TestCase):
    @patch("rag_worker.pipeline.chunk_sections")
    @patch("rag_worker.pipeline.split_into_sections")
    @patch("rag_worker.pipeline.extract_pages")
    def test_reindexes_chunks_and_reprocesses_idempotently(
        self,
        mock_extract_pages,
        mock_split_into_sections,
        mock_chunk_sections,
    ) -> None:
        repository = FakeRepository()
        pipeline = IngestionPipeline(settings=_make_settings(), repository=repository, logger=logging.getLogger(__name__))

        mock_extract_pages.return_value = [ExtractedPage(page_number=1, text="placeholder")]
        mock_split_into_sections.return_value = [
            Section(page_number=1, section_title="Overview", text="This is the first section."),
            Section(page_number=1, section_title="Details", text="This is the second section."),
        ]

        def duplicate_chunk_indexes(*args, **kwargs):
            section = kwargs["sections"][0]
            return [
                ChunkCandidate(
                    chunk_index=0,
                    page_number=section.page_number,
                    section_title=section.section_title,
                    content=f"{section.section_title} content " * 20,
                    language="EN",
                )
            ]

        mock_chunk_sections.side_effect = duplicate_chunk_indexes

        job = IngestionJob(id="job-1", document_id="doc-1", status="processing", attempt=1)
        pipeline.process_job(job)
        pipeline.process_job(job)

        self.assertEqual(len(repository.replaced_chunks_history), 2)
        first_pass = repository.replaced_chunks_history[0]
        second_pass = repository.replaced_chunks_history[1]

        self.assertEqual([chunk.chunk_index for chunk in first_pass], [0, 1])
        self.assertEqual([chunk.chunk_index for chunk in second_pass], [0, 1])

        first_signature = [(chunk.chunk_index, chunk.page_number, chunk.section_title) for chunk in first_pass]
        second_signature = [(chunk.chunk_index, chunk.page_number, chunk.section_title) for chunk in second_pass]
        self.assertEqual(first_signature, second_signature)

        self.assertEqual(repository.completed_jobs, ["job-1", "job-1"])


if __name__ == "__main__":
    unittest.main()
