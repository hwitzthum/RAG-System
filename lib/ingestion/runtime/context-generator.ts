import type {
  ChunkCandidate,
  ChunkWithContext,
  IngestionRuntimeSettings,
  RuntimeLogger,
} from "@/lib/ingestion/runtime/types";

type OpenAiChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
  };
};

export class ContextGenerator {
  private readonly apiKey: string | null;
  private readonly settings: IngestionRuntimeSettings;
  private readonly logger: RuntimeLogger;

  constructor(settings: IngestionRuntimeSettings, logger: RuntimeLogger) {
    this.settings = settings;
    this.logger = logger;
    this.apiKey = settings.openAiApiKey;
  }

  private heuristicContext(chunk: ChunkCandidate): string {
    let compact = chunk.content.replace(/\s+/g, " ").trim();
    const prefix = `${chunk.sectionTitle} | page ${chunk.pageNumber}`;

    if (compact.length > this.settings.contextMaxChars) {
      compact = `${compact.slice(0, this.settings.contextMaxChars).trimEnd()}...`;
    }

    return `${prefix}: ${compact}`;
  }

  private async llmContext(chunk: ChunkCandidate): Promise<string> {
    if (!this.apiKey) {
      return this.heuristicContext(chunk);
    }

    const systemPrompt =
      "Create a concise retrieval context summary for this document chunk. Keep factual entities and key qualifiers. Max 2 sentences.";

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(this.settings.openAiTimeoutSeconds * 1000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.settings.contextModel,
        temperature: 0,
        max_tokens: 140,
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content:
              `Language: ${chunk.language}\n` +
              `Section: ${chunk.sectionTitle}\n` +
              `Page: ${chunk.pageNumber}\n` +
              `Chunk:\n${chunk.content}`,
          },
        ],
      }),
    });

    const payload = (await response.json()) as OpenAiChatCompletionResponse;
    if (!response.ok) {
      const message = payload.error?.message ?? `Context generation request failed (status=${response.status})`;
      throw new Error(message);
    }

    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return this.heuristicContext(chunk);
    }

    return content;
  }

  private async enrichSingle(chunk: ChunkCandidate): Promise<ChunkWithContext> {
    let context: string;
    if (!this.settings.contextEnabled || !this.apiKey) {
      context = this.heuristicContext(chunk);
    } else {
      try {
        context = await this.llmContext(chunk);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown_context_generation_error";
        this.logger.warn("context_generation_failed", { chunkIndex: chunk.chunkIndex, message });
        context = this.heuristicContext(chunk);
      }
    }

    return {
      chunkIndex: chunk.chunkIndex,
      pageNumber: chunk.pageNumber,
      sectionTitle: chunk.sectionTitle,
      content: chunk.content,
      context,
      language: chunk.language,
    };
  }

  async enrich(chunks: ChunkCandidate[]): Promise<ChunkWithContext[]> {
    // Process in parallel batches of 5 to balance throughput vs rate limits.
    const BATCH_SIZE = 5;
    const enriched: ChunkWithContext[] = [];

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((chunk) => this.enrichSingle(chunk)));
      enriched.push(...results);
    }

    return enriched;
  }
}
