import Anthropic from "@anthropic-ai/sdk";

import type {
  ChunkCandidate,
  ChunkWithContext,
  IngestionRuntimeSettings,
  RuntimeLogger,
} from "@/lib/ingestion/runtime/types";

const CONTEXT_SYSTEM_PROMPT =
  "Create a concise retrieval context summary for this document chunk. Keep factual entities and key qualifiers. Max 2 sentences.";

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
  private readonly anthropicApiKey: string | null;
  private readonly settings: IngestionRuntimeSettings;
  private readonly logger: RuntimeLogger;

  constructor(settings: IngestionRuntimeSettings, logger: RuntimeLogger) {
    this.settings = settings;
    this.logger = logger;
    this.apiKey = settings.openAiApiKey;
    this.anthropicApiKey = settings.anthropicApiKey;
  }

  private heuristicContext(chunk: ChunkCandidate): string {
    let compact = chunk.content.replace(/\s+/g, " ").trim();
    const prefix = `${chunk.sectionTitle} | page ${chunk.pageNumber}`;

    if (compact.length > this.settings.contextMaxChars) {
      compact = `${compact.slice(0, this.settings.contextMaxChars).trimEnd()}...`;
    }

    return `${prefix}: ${compact}`;
  }

  private async openAiContext(chunk: ChunkCandidate): Promise<string> {
    if (!this.apiKey) {
      return this.heuristicContext(chunk);
    }

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
            content: CONTEXT_SYSTEM_PROMPT,
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

  private async claudeContext(chunk: ChunkCandidate): Promise<string> {
    const client = new Anthropic({ apiKey: this.anthropicApiKey! });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 140,
      system: [
        {
          type: "text",
          text: CONTEXT_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content:
            `Language: ${chunk.language}\n` +
            `Section: ${chunk.sectionTitle}\n` +
            `Page: ${chunk.pageNumber}\n` +
            `Chunk:\n${chunk.content}`,
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (textBlock && textBlock.type === "text") {
      const text = textBlock.text?.trim();
      if (text) return text;
    }
    return this.heuristicContext(chunk);
  }

  private async enrichSingle(chunk: ChunkCandidate): Promise<ChunkWithContext> {
    let context: string;
    if (!this.settings.contextEnabled) {
      context = this.heuristicContext(chunk);
    } else if (this.anthropicApiKey) {
      try {
        context = await this.claudeContext(chunk);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown_claude_context_error";
        this.logger.warn("claude_context_failed_trying_openai", { chunkIndex: chunk.chunkIndex, message });
        try {
          context = await this.openAiContext(chunk);
        } catch {
          context = this.heuristicContext(chunk);
        }
      }
    } else if (this.apiKey) {
      try {
        context = await this.openAiContext(chunk);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown_context_generation_error";
        this.logger.warn("context_generation_failed", { chunkIndex: chunk.chunkIndex, message });
        context = this.heuristicContext(chunk);
      }
    } else {
      context = this.heuristicContext(chunk);
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
