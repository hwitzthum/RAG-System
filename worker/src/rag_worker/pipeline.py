from collections import Counter
from logging import Logger

from rag_worker.chunking import chunk_sections, split_into_sections
from rag_worker.config import WorkerSettings
from rag_worker.context_generator import ContextGenerator
from rag_worker.embedding_provider import EmbeddingProvider
from rag_worker.language import detect_language
from rag_worker.pdf_extractor import extract_pages
from rag_worker.repository import WorkerRepository
from rag_worker.types import ChunkCandidate, IngestionJob, PreparedChunkRecord


class IngestionPipeline:
    def __init__(self, settings: WorkerSettings, repository: WorkerRepository, logger: Logger) -> None:
        self.settings = settings
        self.repository = repository
        self.logger = logger
        self.context_generator = ContextGenerator(settings=settings, logger=logger)
        self.embedding_provider = EmbeddingProvider(settings=settings, logger=logger)

    def _determine_document_language(self, chunk_languages: list[str], fallback: str | None) -> str:
        if fallback:
            return fallback
        if not chunk_languages:
            return "EN"
        return Counter(chunk_languages).most_common(1)[0][0]

    @staticmethod
    def _reindex_chunks(chunks: list[ChunkCandidate]) -> list[ChunkCandidate]:
        reindexed: list[ChunkCandidate] = []

        for index, chunk in enumerate(chunks):
            if chunk.chunk_index == index:
                reindexed.append(chunk)
                continue

            reindexed.append(
                ChunkCandidate(
                    chunk_index=index,
                    page_number=chunk.page_number,
                    section_title=chunk.section_title,
                    content=chunk.content,
                    language=chunk.language,
                )
            )

        return reindexed

    def process_job(self, job: IngestionJob) -> None:
        document = self.repository.get_document(job.document_id)
        self.repository.set_document_status(document.id, "processing")

        pdf_bytes = self.repository.download_document(document.storage_path)
        pages = extract_pages(pdf_bytes, self.settings.worker_ocr_fallback_enabled, self.logger)

        sections = []
        for page in pages:
            if page.text.strip():
                sections.extend(split_into_sections(page))

        if not sections:
            raise RuntimeError("No extractable text found in document")

        chunk_candidates = []
        for section in sections:
            detected_language = detect_language(section.text, document.language)
            section_chunks = chunk_sections(
                sections=[section],
                language=detected_language,
                target_tokens=self.settings.worker_chunk_target_tokens,
                overlap_tokens=self.settings.worker_chunk_overlap_tokens,
                min_chars=self.settings.worker_chunk_min_chars,
            )
            chunk_candidates.extend(section_chunks)

        chunk_candidates = self._reindex_chunks(chunk_candidates)

        if not chunk_candidates:
            raise RuntimeError("No chunks generated from extracted sections")

        chunks_with_context = self.context_generator.enrich(chunk_candidates)

        embedding_inputs = [f"{item.context}\n\n{item.content}" for item in chunks_with_context]
        embeddings = self.embedding_provider.embed_texts(embedding_inputs)

        if len(embeddings) != len(chunks_with_context):
            raise RuntimeError("Embedding response size mismatch")

        prepared_chunks: list[PreparedChunkRecord] = []
        for chunk, embedding in zip(chunks_with_context, embeddings, strict=True):
            if len(embedding) != self.settings.worker_embedding_dim:
                raise RuntimeError(
                    f"Embedding dimension mismatch for chunk {chunk.chunk_index}: "
                    f"expected {self.settings.worker_embedding_dim}, got {len(embedding)}"
                )
            prepared_chunks.append(
                PreparedChunkRecord(
                    document_id=document.id,
                    chunk_index=chunk.chunk_index,
                    page_number=chunk.page_number,
                    section_title=chunk.section_title,
                    content=chunk.content,
                    context=chunk.context,
                    language=chunk.language,
                    embedding=embedding,
                )
            )

        self.repository.replace_document_chunks(document.id, prepared_chunks)

        selected_language = self._determine_document_language(
            chunk_languages=[item.language for item in chunks_with_context],
            fallback=document.language,
        )
        self.repository.set_document_status(document.id, "ready", language=selected_language)
        self.repository.mark_job_completed(job.id)

        self.logger.info(
            "ingestion_job_completed",
            extra={
                "job_id": job.id,
                "document_id": document.id,
                "chunks": len(prepared_chunks),
                "language": selected_language,
            },
        )
