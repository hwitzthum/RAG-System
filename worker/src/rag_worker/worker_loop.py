import time
from logging import Logger

from rag_worker.config import WorkerSettings
from rag_worker.pipeline import IngestionPipeline
from rag_worker.repository import WorkerRepository


class IngestionWorker:
    def __init__(self, settings: WorkerSettings, logger: Logger) -> None:
        self.settings = settings
        self.logger = logger
        self.repository = WorkerRepository(settings=settings, logger=logger)
        self.pipeline = IngestionPipeline(settings=settings, repository=self.repository, logger=logger)

    def run_once(self) -> bool:
        job = self.repository.claim_next_job()
        if not job:
            self.logger.info("no_jobs_available")
            return False

        self.logger.info(
            "job_claimed",
            extra={"job_id": job.id, "document_id": job.document_id, "attempt": job.attempt},
        )

        try:
            self.pipeline.process_job(job)
            return True
        except Exception as exc:
            dead_letter = self.repository.mark_job_failed(job, str(exc))
            if dead_letter:
                self.repository.set_document_status(job.document_id, "failed")
                self.logger.error(
                    "job_dead_lettered",
                    extra={"job_id": job.id, "document_id": job.document_id, "error": str(exc)},
                )
            else:
                # Keep document queued for the next retry attempt.
                self.repository.set_document_status(job.document_id, "queued")
                self.logger.warning(
                    "job_failed_retry_scheduled",
                    extra={"job_id": job.id, "document_id": job.document_id, "error": str(exc)},
                )
            return True

    def run_forever(self) -> None:
        while True:
            processed = self.run_once()
            if not processed:
                time.sleep(self.settings.poll_interval_seconds)
