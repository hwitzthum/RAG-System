import type {
  IngestionRuntimeSettings,
  RuntimeLogger,
} from "@/lib/ingestion/runtime/types";

type OpenAiEmbeddingResponse = {
  data?: Array<{
    embedding?: number[];
  }>;
  error?: {
    message?: string;
  };
};

export class EmbeddingProvider {
  private readonly apiKey: string | null;
  private readonly settings: IngestionRuntimeSettings;
  private readonly logger: RuntimeLogger;

  constructor(settings: IngestionRuntimeSettings, logger: RuntimeLogger) {
    this.settings = settings;
    this.logger = logger;
    this.apiKey = settings.openAiApiKey;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    if (!this.apiKey) {
      // Previously this silently wrote SHA-256-derived fake vectors that were
      // indistinguishable from real embeddings in the database. Failing the
      // job (retry -> dead letter) is the only honest behaviour: corrupt
      // embeddings poison retrieval for every future query.
      this.logger.error("embedding_api_key_missing", {
        model: this.settings.embeddingModel,
      });
      throw new Error(
        "OPENAI_API_KEY is not configured; refusing to ingest without real embeddings",
      );
    }

    const vectors: number[][] = [];
    const batchSize = Math.max(1, this.settings.embeddingBatchSize);

    for (let index = 0; index < texts.length; index += batchSize) {
      const batch = texts.slice(index, index + batchSize);
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        signal: AbortSignal.timeout(this.settings.openAiTimeoutSeconds * 1000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.settings.embeddingModel,
          input: batch,
          ...(this.settings.embeddingDimensions
            ? { dimensions: this.settings.embeddingDimensions }
            : {}),
        }),
      });

      const payload = (await response.json()) as OpenAiEmbeddingResponse;
      if (!response.ok) {
        const message =
          payload.error?.message ??
          `Embedding provider request failed (status=${response.status})`;
        this.logger.warn("embedding_request_failed", {
          message,
          batchSize: batch.length,
        });
        throw new Error(message);
      }

      for (const item of payload.data ?? []) {
        const embedding = item.embedding ?? [];
        vectors.push(embedding);
      }
    }

    return vectors;
  }
}
