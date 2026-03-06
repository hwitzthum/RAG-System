import logging
import unittest

from rag_worker.config import WorkerSettings
from rag_worker.types import IngestionJob
from rag_worker.worker_loop import IngestionWorker


def _make_settings() -> WorkerSettings:
    return WorkerSettings(
        SUPABASE_URL="https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY="service-role-key",
    )


class FakeRepository:
    def __init__(self, dead_letter: bool) -> None:
        self.dead_letter = dead_letter
        self.status_updates: list[tuple[str, str]] = []
        self.failed_calls: list[tuple[str, str]] = []
        self.job = IngestionJob(id="job-1", document_id="doc-1", status="processing", attempt=1)

    def claim_next_job(self) -> IngestionJob | None:
        return self.job

    def mark_job_failed(self, job: IngestionJob, error_message: str) -> bool:
        self.failed_calls.append((job.id, error_message))
        return self.dead_letter

    def set_document_status(self, document_id: str, status: str, language: str | None = None) -> None:
        self.status_updates.append((document_id, status))


class FailingPipeline:
    def process_job(self, job: IngestionJob) -> None:
        raise RuntimeError("pipeline exploded")


class WorkerLoopTests(unittest.TestCase):
    def test_failed_job_schedules_retry(self) -> None:
        worker = IngestionWorker.__new__(IngestionWorker)
        worker.settings = _make_settings()
        worker.logger = logging.getLogger(__name__)
        worker.repository = FakeRepository(dead_letter=False)
        worker.pipeline = FailingPipeline()

        processed = worker.run_once()

        self.assertTrue(processed)
        self.assertEqual(worker.repository.status_updates, [("doc-1", "queued")])
        self.assertEqual(len(worker.repository.failed_calls), 1)

    def test_failed_job_goes_to_dead_letter(self) -> None:
        worker = IngestionWorker.__new__(IngestionWorker)
        worker.settings = _make_settings()
        worker.logger = logging.getLogger(__name__)
        worker.repository = FakeRepository(dead_letter=True)
        worker.pipeline = FailingPipeline()

        processed = worker.run_once()

        self.assertTrue(processed)
        self.assertEqual(worker.repository.status_updates, [("doc-1", "failed")])
        self.assertEqual(len(worker.repository.failed_calls), 1)


if __name__ == "__main__":
    unittest.main()
