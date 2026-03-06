from logging import Logger

from openai import OpenAI

from rag_worker.config import WorkerSettings
from rag_worker.types import ChunkCandidate, ChunkWithContext


class ContextGenerator:
    def __init__(self, settings: WorkerSettings, logger: Logger) -> None:
        self.settings = settings
        self.logger = logger
        self.client: OpenAI | None = None
        if settings.openai_api_key:
            self.client = OpenAI(api_key=settings.openai_api_key, timeout=settings.worker_openai_timeout_seconds)

    def _heuristic_context(self, chunk: ChunkCandidate) -> str:
        compact = " ".join(chunk.content.split())
        prefix = f"{chunk.section_title} | page {chunk.page_number}"
        if len(compact) > self.settings.worker_context_max_chars:
            compact = compact[: self.settings.worker_context_max_chars].rstrip() + "..."
        return f"{prefix}: {compact}"

    def _llm_context(self, chunk: ChunkCandidate) -> str:
        if not self.client:
            return self._heuristic_context(chunk)

        prompt = (
            "Create a concise retrieval context summary for this brochure chunk. "
            "Keep factual entities and key qualifiers. Max 2 sentences."
        )

        response = self.client.chat.completions.create(
            model=self.settings.worker_context_model,
            temperature=0,
            max_tokens=140,
            messages=[
                {"role": "system", "content": prompt},
                {
                    "role": "user",
                    "content": (
                        f"Language: {chunk.language}\n"
                        f"Section: {chunk.section_title}\n"
                        f"Page: {chunk.page_number}\n"
                        f"Chunk:\n{chunk.content}"
                    ),
                },
            ],
        )

        message = response.choices[0].message.content if response.choices else None
        if isinstance(message, str) and message.strip():
            return message.strip()

        return self._heuristic_context(chunk)

    def enrich(self, chunks: list[ChunkCandidate]) -> list[ChunkWithContext]:
        enriched: list[ChunkWithContext] = []

        for chunk in chunks:
            if not self.settings.worker_context_enabled or not self.client:
                context = self._heuristic_context(chunk)
            else:
                try:
                    context = self._llm_context(chunk)
                except Exception as exc:  # pragma: no cover - remote API failure path
                    self.logger.warning(
                        "context_generation_failed",
                        extra={"chunk_index": chunk.chunk_index, "error": str(exc)},
                    )
                    context = self._heuristic_context(chunk)

            enriched.append(
                ChunkWithContext(
                    chunk_index=chunk.chunk_index,
                    page_number=chunk.page_number,
                    section_title=chunk.section_title,
                    content=chunk.content,
                    context=context,
                    language=chunk.language,
                )
            )

        return enriched
