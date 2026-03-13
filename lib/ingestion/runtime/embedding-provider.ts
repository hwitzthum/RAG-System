import { createHash } from "node:crypto";
import type { IngestionRuntimeSettings, RuntimeLogger } from "@/lib/ingestion/runtime/types";

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

  private buildFallbackEmbedding(text: string): number[] {
    const digest = createHash("sha256").update(text, "utf8").digest();
    const vector = new Array<number>(this.settings.embeddingDim).fill(0);

    for (let index = 0; index < this.settings.embeddingDim; index += 1) {
      const byte = digest[index % digest.length] ?? 0;
      vector[index] = (byte / 127.5) - 1.0;
    }

    return vector;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    if (!this.apiKey) {
      return texts.map((text) => this.buildFallbackEmbedding(text));
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
        }),
      });

      const payload = (await response.json()) as OpenAiEmbeddingResponse;
      if (!response.ok) {
        const message = payload.error?.message ?? `Embedding provider request failed (status=${response.status})`;
        this.logger.warn("embedding_request_failed", { message, batchSize: batch.length });
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
