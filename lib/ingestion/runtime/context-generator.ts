import Anthropic from "@anthropic-ai/sdk";

import type {
  ChunkCandidate,
  ChunkWithContext,
  IngestionRuntimeSettings,
  RuntimeLogger,
} from "@/lib/ingestion/runtime/types";

// Contextual-retrieval prompt: the model sees the document's title and
// summary so the chunk context can situate the chunk within the WHOLE
// document (the ingredient that makes contextual retrieval work), not just
// restate the chunk.
const CONTEXT_SYSTEM_PROMPT =
  "Create a concise retrieval context summary that situates this document chunk within the overall document. " +
  "State what the chunk covers and how it relates to the document's subject. " +
  "Keep factual entities and key qualifiers. Max 2 sentences. " +
  // The context string is concatenated into the embedded text and the
  // tsvector. A heading like "**Retrieval Context Summary:**" — which the model
  // emits unprompted — is then prepended to every chunk's vector, identically,
  // which is pure noise in the embedding space.
  "Output the summary sentences only: no heading, no preamble, no markdown.";

const CONTEXT_MODEL = "claude-haiku-4-5-20251001";

const DOCUMENT_SUMMARY_SYSTEM_PROMPT =
  "Summarize this document in one paragraph (max 4 sentences). " +
  "Name the document type, its subject, the key entities involved, and its purpose. " +
  "Write in the document's own language.";

export type DocumentContextMeta = {
  title: string | null;
  summary: string | null;
  /**
   * Full extracted document text. Anthropic's contextual-retrieval recipe puts
   * the whole document behind a cache breakpoint so every chunk is situated
   * against the real thing; the summary path below situates a page-40 clause
   * against a summary of page 1, which is how generated context degenerates
   * into restating the chunk. Absent when the document is outside the size
   * window below, in which case the summary is used as before.
   */
  text?: string | null;
};

/*
 * The minimum cacheable prefix for claude-haiku-4-5 is 4,096 tokens. Below
 * that a `cache_control` breakpoint silently creates no entry — no error,
 * `cache_creation_input_tokens: 0` — and the document would be re-billed in
 * full for every chunk. ~3.5 characters per token puts the floor near 14,300;
 * 16,000 leaves margin for tokenizer variation across languages.
 *
 * The ceiling keeps the request clear of the model's 200K context once chunk
 * text and the reply are added.
 */
const MIN_CACHEABLE_DOCUMENT_CHARS = 16_000;
const MAX_CACHEABLE_DOCUMENT_CHARS = 400_000;

/**
 * Excerpt for the document summary when the full text is not being cached.
 *
 * A flat head slice described only the first page or two, so a summary of a
 * fifty-page handbook was a summary of its cover. Head plus tail plus the
 * heading outline covers what the document opens with, what it concludes, and
 * what lies between.
 */
function buildSummaryExcerpt(text: string): string {
  const compact = text.replace(/[ \t]+/g, " ").trim();
  if (compact.length <= 6_000) {
    return compact.replace(/\s+/g, " ").trim();
  }

  const head = compact.slice(0, 4_000);
  const tail = compact.slice(-2_000);
  const outline = compact
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        line.length <= 120 &&
        /^(?:\d+(?:\.\d+)*\s+)?[A-ZÀ-Ü]/.test(line),
    )
    .slice(0, 60);

  return [
    head,
    outline.length > 0 ? `\n\nSection outline:\n${outline.join("\n")}` : "",
    `\n\nDocument ending:\n${tail}`,
  ].join("");
}

function isCacheableDocument(text: string | null | undefined): text is string {
  if (!text) {
    return false;
  }
  return (
    text.length >= MIN_CACHEABLE_DOCUMENT_CHARS &&
    text.length <= MAX_CACHEABLE_DOCUMENT_CHARS
  );
}

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
  private readonly anthropicClient: Anthropic | null;
  private readonly settings: IngestionRuntimeSettings;
  private readonly logger: RuntimeLogger;

  constructor(settings: IngestionRuntimeSettings, logger: RuntimeLogger) {
    this.settings = settings;
    this.logger = logger;
    this.apiKey = settings.openAiApiKey;
    this.anthropicApiKey = settings.anthropicApiKey;
    this.anthropicClient = this.anthropicApiKey
      ? new Anthropic({
          apiKey: this.anthropicApiKey,
          timeout: this.settings.openAiTimeoutSeconds * 1000,
        })
      : null;
  }

  private heuristicContext(
    chunk: ChunkCandidate,
    document: DocumentContextMeta,
  ): string {
    let compact = chunk.content.replace(/\s+/g, " ").trim();
    const titlePrefix = document.title ? `${document.title} | ` : "";
    const prefix = `${titlePrefix}${chunk.sectionTitle} | page ${chunk.pageNumber}`;

    if (compact.length > this.settings.contextMaxChars) {
      compact = `${compact.slice(0, this.settings.contextMaxChars).trimEnd()}...`;
    }

    return `${prefix}: ${compact}`;
  }

  private buildChunkPromptBody(
    chunk: ChunkCandidate,
    document: DocumentContextMeta,
  ): string {
    const documentLines = [
      document.title ? `Document title: ${document.title}` : null,
      document.summary ? `Document summary: ${document.summary}` : null,
    ].filter((line): line is string => line !== null);

    return [
      ...documentLines,
      `Language: ${chunk.language}`,
      `Section: ${chunk.sectionTitle}`,
      `Page: ${chunk.pageNumber}`,
      `Chunk:\n${chunk.content}`,
    ].join("\n");
  }

  private async openAiContext(
    chunk: ChunkCandidate,
    document: DocumentContextMeta,
  ): Promise<string> {
    if (!this.apiKey) {
      return this.heuristicContext(chunk, document);
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
            content: this.buildChunkPromptBody(chunk, document),
          },
        ],
      }),
    });

    const payload = (await response.json()) as OpenAiChatCompletionResponse;
    if (!response.ok) {
      const message =
        payload.error?.message ??
        `Context generation request failed (status=${response.status})`;
      throw new Error(message);
    }

    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return this.heuristicContext(chunk, document);
    }

    return content;
  }

  /**
   * The cached prefix: the whole document, identical for every chunk of it.
   * Must be byte-stable — any variation invalidates the entry and re-bills the
   * document at the write rate.
   */
  private buildDocumentBlock(document: DocumentContextMeta): string {
    return [
      document.title ? `Document title: ${document.title}` : null,
      "Full document text:",
      document.text ?? "",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  /**
   * Writes the document into the cache with a single request before the
   * per-chunk batches run.
   *
   * `enrich` processes chunks five at a time with `Promise.all`, and a cache
   * entry only becomes readable once the first response begins streaming — so
   * without this, all five of the first batch miss and each pays the write.
   * `max_tokens: 0` runs prefill, writes the entry, returns immediately with an
   * empty content array, and bills no output tokens.
   */
  private async prewarmDocumentCache(
    document: DocumentContextMeta,
  ): Promise<void> {
    try {
      const response = await this.anthropicClient!.messages.create({
        model: CONTEXT_MODEL,
        max_tokens: 0,
        system: CONTEXT_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: this.buildDocumentBlock(document),
                cache_control: { type: "ephemeral", ttl: "1h" },
              },
            ],
          },
        ],
      });
      this.logger.info("context_cache_prewarmed", {
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens,
        cacheReadInputTokens: response.usage.cache_read_input_tokens,
      });
    } catch (error) {
      // A failed pre-warm costs cache writes on the first batch, nothing more.
      this.logger.warn("context_cache_prewarm_failed", {
        message: error instanceof Error ? error.message : "unknown_error",
      });
    }
  }

  private async claudeContext(
    chunk: ChunkCandidate,
    document: DocumentContextMeta,
  ): Promise<string> {
    const cacheable = isCacheableDocument(document.text);

    /*
     * The breakpoint sits on the document block, not the system prompt.
     * `CONTEXT_SYSTEM_PROMPT` is ~45 tokens against a 4,096-token minimum, so
     * the marker it used to carry never created a cache entry at all — no
     * error, and full price paid per chunk.
     */
    const content = cacheable
      ? [
          {
            type: "text" as const,
            text: this.buildDocumentBlock(document),
            cache_control: { type: "ephemeral" as const, ttl: "1h" as const },
          },
          {
            type: "text" as const,
            text: this.buildChunkPromptBody(chunk, document),
          },
        ]
      : [
          {
            type: "text" as const,
            text: this.buildChunkPromptBody(chunk, document),
          },
        ];

    const response = await this.anthropicClient!.messages.create({
      model: CONTEXT_MODEL,
      max_tokens: 140,
      system: CONTEXT_SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    });

    if (cacheable) {
      // The acceptance test for this whole item: reads staying at zero means
      // the document is being re-billed per chunk, not cached.
      this.logger.info("context_cache", {
        chunkIndex: chunk.chunkIndex,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens,
        cacheReadInputTokens: response.usage.cache_read_input_tokens,
        inputTokens: response.usage.input_tokens,
      });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (textBlock && textBlock.type === "text") {
      const text = textBlock.text?.trim();
      if (text) return text;
    }
    return this.heuristicContext(chunk, document);
  }

  private async enrichSingle(
    chunk: ChunkCandidate,
    document: DocumentContextMeta,
  ): Promise<ChunkWithContext> {
    let context: string;
    if (!this.settings.contextEnabled) {
      context = this.heuristicContext(chunk, document);
    } else if (this.anthropicApiKey) {
      try {
        context = await this.claudeContext(chunk, document);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "unknown_claude_context_error";
        this.logger.warn("claude_context_failed_trying_openai", {
          chunkIndex: chunk.chunkIndex,
          message,
        });
        try {
          context = await this.openAiContext(chunk, document);
        } catch {
          context = this.heuristicContext(chunk, document);
        }
      }
    } else if (this.apiKey) {
      try {
        context = await this.openAiContext(chunk, document);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "unknown_context_generation_error";
        this.logger.warn("context_generation_failed", {
          chunkIndex: chunk.chunkIndex,
          message,
        });
        context = this.heuristicContext(chunk, document);
      }
    } else {
      context = this.heuristicContext(chunk, document);
    }

    // Spread rather than field-by-field so optional provenance fields
    // (extractionMethod, tokenCount) survive enrichment.
    return {
      ...chunk,
      context,
    };
  }

  async enrich(
    chunks: ChunkCandidate[],
    document: DocumentContextMeta = { title: null, summary: null },
  ): Promise<ChunkWithContext[]> {
    // Process in parallel batches of 5 to balance throughput vs rate limits.
    const BATCH_SIZE = 5;
    const enriched: ChunkWithContext[] = [];

    if (
      this.settings.contextEnabled &&
      this.anthropicApiKey &&
      chunks.length > 1 &&
      isCacheableDocument(document.text)
    ) {
      await this.prewarmDocumentCache(document);
    }

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map((chunk) => this.enrichSingle(chunk, document)),
      );
      enriched.push(...results);
    }

    return enriched;
  }

  private heuristicDocumentSummary(title: string | null, text: string): string {
    const compact = text.replace(/\s+/g, " ").trim().slice(0, 400);
    return title ? `${title}: ${compact}` : compact;
  }

  /**
   * One-paragraph document summary generated once per document at ingest and
   * fed into every chunk's context prompt. Falls back to a truncated excerpt
   * when no LLM is available — a weak summary beats none for situating chunks.
   */
  async summarizeDocument(input: {
    title: string | null;
    text: string;
  }): Promise<string> {
    const excerpt = buildSummaryExcerpt(input.text);
    if (!excerpt) {
      return input.title ?? "";
    }

    const userContent = [
      input.title ? `Document title: ${input.title}` : null,
      `Document text (excerpt):\n${excerpt}`,
    ]
      .filter((line): line is string => line !== null)
      .join("\n\n");

    if (this.settings.contextEnabled && this.anthropicApiKey) {
      try {
        const response = await this.anthropicClient!.messages.create({
          model: CONTEXT_MODEL,
          max_tokens: 220,
          system: DOCUMENT_SUMMARY_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userContent }],
        });
        const textBlock = response.content.find((b) => b.type === "text");
        if (textBlock && textBlock.type === "text" && textBlock.text?.trim()) {
          return textBlock.text.trim();
        }
      } catch (error) {
        this.logger.warn("claude_document_summary_failed", {
          message: error instanceof Error ? error.message : "unknown_error",
        });
      }
    }

    if (this.settings.contextEnabled && this.apiKey) {
      try {
        const response = await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            signal: AbortSignal.timeout(
              this.settings.openAiTimeoutSeconds * 1000,
            ),
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
              model: this.settings.contextModel,
              temperature: 0,
              max_tokens: 220,
              messages: [
                { role: "system", content: DOCUMENT_SUMMARY_SYSTEM_PROMPT },
                { role: "user", content: userContent },
              ],
            }),
          },
        );
        const payload = (await response.json()) as OpenAiChatCompletionResponse;
        const content = payload.choices?.[0]?.message?.content?.trim();
        if (response.ok && content) {
          return content;
        }
      } catch (error) {
        this.logger.warn("document_summary_failed", {
          message: error instanceof Error ? error.message : "unknown_error",
        });
      }
    }

    return this.heuristicDocumentSummary(input.title, input.text);
  }
}
