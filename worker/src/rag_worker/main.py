import argparse

from rag_worker.config import get_settings
from rag_worker.logging_utils import get_logger
from rag_worker.worker_loop import IngestionWorker


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="RAG ingestion worker")
    parser.add_argument("--once", action="store_true", help="Process at most one job and exit")
    parser.add_argument(
        "--max-jobs",
        type=int,
        default=0,
        help="Process up to N jobs then exit (0 means unbounded in loop mode)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    logger = get_logger()
    settings = get_settings()

    logger.info(
        "worker_starting",
        extra={
            "worker_name": settings.worker_name,
            "poll_interval_seconds": settings.poll_interval_seconds,
            "max_retries": settings.max_retries,
            "chunk_target_tokens": settings.worker_chunk_target_tokens,
            "chunk_overlap_tokens": settings.worker_chunk_overlap_tokens,
            "context_enabled": settings.worker_context_enabled,
            "embedding_model": settings.worker_embedding_model,
        },
    )

    worker = IngestionWorker(settings=settings, logger=logger)

    if args.once:
        worker.run_once()
        return

    if args.max_jobs > 0:
        for _ in range(args.max_jobs):
            processed = worker.run_once()
            if not processed:
                break
        return

    worker.run_forever()


if __name__ == "__main__":
    main()
