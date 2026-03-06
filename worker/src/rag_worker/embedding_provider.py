import hashlib
from logging import Logger

from openai import OpenAI

from rag_worker.config import WorkerSettings


class EmbeddingProvider:
    def __init__(self, settings: WorkerSettings, logger: Logger) -> None:
        self.settings = settings
        self.logger = logger
        self.client: OpenAI | None = None
        if settings.openai_api_key:
            self.client = OpenAI(api_key=settings.openai_api_key, timeout=settings.worker_openai_timeout_seconds)

    def _fallback_embedding(self, text: str) -> list[float]:
        # Deterministic fallback used when OPENAI_API_KEY is unavailable.
        digest = hashlib.sha256(text.encode("utf-8")).digest()
        vector = [0.0] * self.settings.worker_embedding_dim

        for idx in range(self.settings.worker_embedding_dim):
            byte = digest[idx % len(digest)]
            vector[idx] = (byte / 127.5) - 1.0

        return vector

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []

        if not self.client:
            return [self._fallback_embedding(text) for text in texts]

        vectors: list[list[float]] = []
        batch_size = max(1, self.settings.worker_embedding_batch_size)

        for index in range(0, len(texts), batch_size):
            batch = texts[index : index + batch_size]
            response = self.client.embeddings.create(model=self.settings.worker_embedding_model, input=batch)
            vectors.extend([item.embedding for item in response.data])

        return vectors
