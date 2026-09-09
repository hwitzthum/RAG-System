import { z } from "zod";
import { sharedEnvFields } from "@/lib/config/env-fields";
import { normalizeEnvValues } from "@/lib/config/normalize-env";
import type { IngestionRuntimeSettings } from "@/lib/ingestion/runtime/types";

/**
 * The ingestion worker's environment, validated.
 *
 * Deliberately separate from `lib/config/env.ts`: that module requires the
 * variables the Next.js application cannot run without (Supabase keys, an auth
 * secret, an OpenAI key) and throws at import time when one is missing. The
 * worker does reach that schema in production — `run-worker.ts` loads it
 * through the Supabase admin client before it claims its first job — but the
 * ingestion test suite never does, and depends on not doing so: it runs with
 * no environment at all. Importing the application schema here would make
 * every one of those tests carry a full fake environment.
 *
 * Values are rejected rather than silently replaced. The hand-rolled parsers
 * this replaced fell back to the default whenever a value failed to parse, so
 * `WORKER_CHUNK_TARGET_TOKENS=abc` produced a worker that ran happily on 700
 * and never mentioned it. A typo in a deployment's configuration is now a
 * refusal to start, naming the variable.
 */

const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const nonEmptyString = (fallback: string) =>
  z.string().min(1).default(fallback);

/**
 * Accepts the same spellings as the application schema's boolean flags, so the
 * two do not disagree about what `WORKER_CONTEXT_ENABLED=1` means. Anything
 * else is an error: the parser this replaced read every unrecognised value as
 * the default, which turned `enabled` or `yes` into a silently disabled
 * feature.
 */
const booleanFlag = (fallback: boolean) =>
  z
    .enum(["true", "1", "false", "0"])
    .optional()
    .transform((value) =>
      value === undefined ? fallback : value === "true" || value === "1",
    );

const ingestionEnvSchema = z.object({
  WORKER_NAME: nonEmptyString("rag-ingestion-worker"),
  WORKER_POLL_INTERVAL_SECONDS: positiveInt(5),
  INGESTION_BATCH_SIZE: sharedEnvFields.INGESTION_BATCH_SIZE,
  WORKER_MAX_RETRIES: positiveInt(3),
  WORKER_CHUNK_TARGET_TOKENS: positiveInt(700),
  WORKER_CHUNK_OVERLAP_TOKENS: positiveInt(120),
  WORKER_CHUNK_MIN_CHARS: positiveInt(120),
  // Falls back to the answering model when unset; see resolveIngestionEnv.
  WORKER_CONTEXT_MODEL: z.string().min(1).optional(),
  RAG_LLM_MODEL: sharedEnvFields.RAG_LLM_MODEL,
  WORKER_CONTEXT_ENABLED: booleanFlag(true),
  WORKER_CONTEXT_MAX_CHARS: positiveInt(280),
  // Falls back to the query embedding model when unset. Indexing and querying
  // with different models produces embeddings that are not comparable, so the
  // shared default is the point, not a convenience.
  WORKER_EMBEDDING_MODEL: z.string().min(1).optional(),
  RAG_QUERY_EMBEDDING_MODEL: sharedEnvFields.RAG_QUERY_EMBEDDING_MODEL,
  WORKER_EMBEDDING_DIM: positiveInt(1024),
  WORKER_EMBEDDING_BATCH_SIZE: positiveInt(32),
  WORKER_OPENAI_TIMEOUT_SECONDS: positiveInt(40),
  // Optional here, unlike in the application schema: the pipeline degrades to
  // its no-key paths, and the tests rely on resolving settings without one.
  OPENAI_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  WORKER_EMBEDDING_DIMENSIONS: positiveInt(1024),
  WORKER_OCR_FALLBACK_ENABLED: booleanFlag(true),
  // Independent of RAG_LLM_MODEL despite the matching default: this one has to
  // be a vision model, so the two move for different reasons.
  WORKER_OCR_MODEL: nonEmptyString("gpt-4o-mini"),
  WORKER_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().positive().optional(),
  INGESTION_LOCK_TIMEOUT_SECONDS:
    sharedEnvFields.INGESTION_LOCK_TIMEOUT_SECONDS,
  WORKER_CHUNKS_PER_RUN: positiveInt(5),
  WORKER_CHUNK_INSERT_BATCH_SIZE: positiveInt(100),
  RAG_STORAGE_BUCKET: sharedEnvFields.RAG_STORAGE_BUCKET,
});

/**
 * Reads `process.env` on every call rather than caching, matching what the
 * resolver it replaced did — `runIngestionBatch` resolves settings per batch,
 * and a long-lived worker should see a value that changed under it.
 */
export function resolveIngestionEnv(): IngestionRuntimeSettings {
  const source = normalizeEnvValues({
    WORKER_NAME: process.env.WORKER_NAME,
    WORKER_POLL_INTERVAL_SECONDS: process.env.WORKER_POLL_INTERVAL_SECONDS,
    INGESTION_BATCH_SIZE: process.env.INGESTION_BATCH_SIZE,
    WORKER_MAX_RETRIES: process.env.WORKER_MAX_RETRIES,
    WORKER_CHUNK_TARGET_TOKENS: process.env.WORKER_CHUNK_TARGET_TOKENS,
    WORKER_CHUNK_OVERLAP_TOKENS: process.env.WORKER_CHUNK_OVERLAP_TOKENS,
    WORKER_CHUNK_MIN_CHARS: process.env.WORKER_CHUNK_MIN_CHARS,
    WORKER_CONTEXT_MODEL: process.env.WORKER_CONTEXT_MODEL,
    RAG_LLM_MODEL: process.env.RAG_LLM_MODEL,
    WORKER_CONTEXT_ENABLED: process.env.WORKER_CONTEXT_ENABLED,
    WORKER_CONTEXT_MAX_CHARS: process.env.WORKER_CONTEXT_MAX_CHARS,
    WORKER_EMBEDDING_MODEL: process.env.WORKER_EMBEDDING_MODEL,
    RAG_QUERY_EMBEDDING_MODEL: process.env.RAG_QUERY_EMBEDDING_MODEL,
    WORKER_EMBEDDING_DIM: process.env.WORKER_EMBEDDING_DIM,
    WORKER_EMBEDDING_BATCH_SIZE: process.env.WORKER_EMBEDDING_BATCH_SIZE,
    WORKER_OPENAI_TIMEOUT_SECONDS: process.env.WORKER_OPENAI_TIMEOUT_SECONDS,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    WORKER_EMBEDDING_DIMENSIONS: process.env.WORKER_EMBEDDING_DIMENSIONS,
    WORKER_OCR_FALLBACK_ENABLED: process.env.WORKER_OCR_FALLBACK_ENABLED,
    WORKER_OCR_MODEL: process.env.WORKER_OCR_MODEL,
    WORKER_LOCK_TIMEOUT_SECONDS: process.env.WORKER_LOCK_TIMEOUT_SECONDS,
    INGESTION_LOCK_TIMEOUT_SECONDS: process.env.INGESTION_LOCK_TIMEOUT_SECONDS,
    WORKER_CHUNKS_PER_RUN: process.env.WORKER_CHUNKS_PER_RUN,
    WORKER_CHUNK_INSERT_BATCH_SIZE: process.env.WORKER_CHUNK_INSERT_BATCH_SIZE,
    RAG_STORAGE_BUCKET: process.env.RAG_STORAGE_BUCKET,
  });

  const parsed = ingestionEnvSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid ingestion environment: ${details}`);
  }

  const env = parsed.data;

  return {
    workerName: env.WORKER_NAME,
    workerPollIntervalSeconds: env.WORKER_POLL_INTERVAL_SECONDS,
    ingestionBatchSize: env.INGESTION_BATCH_SIZE,
    maxRetries: env.WORKER_MAX_RETRIES,
    chunkTargetTokens: env.WORKER_CHUNK_TARGET_TOKENS,
    chunkOverlapTokens: env.WORKER_CHUNK_OVERLAP_TOKENS,
    chunkMinChars: env.WORKER_CHUNK_MIN_CHARS,
    contextModel: env.WORKER_CONTEXT_MODEL ?? env.RAG_LLM_MODEL,
    contextEnabled: env.WORKER_CONTEXT_ENABLED,
    contextMaxChars: env.WORKER_CONTEXT_MAX_CHARS,
    embeddingModel: env.WORKER_EMBEDDING_MODEL ?? env.RAG_QUERY_EMBEDDING_MODEL,
    embeddingDim: env.WORKER_EMBEDDING_DIM,
    embeddingBatchSize: env.WORKER_EMBEDDING_BATCH_SIZE,
    openAiTimeoutSeconds: env.WORKER_OPENAI_TIMEOUT_SECONDS,
    openAiApiKey: env.OPENAI_API_KEY ?? null,
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? null,
    embeddingDimensions: env.WORKER_EMBEDDING_DIMENSIONS,
    ocrFallbackEnabled: env.WORKER_OCR_FALLBACK_ENABLED,
    ocrModel: env.WORKER_OCR_MODEL,
    lockTimeoutSeconds:
      env.WORKER_LOCK_TIMEOUT_SECONDS ?? env.INGESTION_LOCK_TIMEOUT_SECONDS,
    chunksPerRun: env.WORKER_CHUNKS_PER_RUN,
    chunkInsertBatchSize: env.WORKER_CHUNK_INSERT_BATCH_SIZE,
    ragStorageBucket: env.RAG_STORAGE_BUCKET,
  };
}
