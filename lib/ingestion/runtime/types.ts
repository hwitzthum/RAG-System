import type { DocumentStatus, IngestionJobStatus, SupportedLanguage } from "@/lib/supabase/database.types";

export type RuntimeLogger = Pick<Console, "info" | "warn" | "error">;

export type IngestionJob = {
  id: string;
  documentId: string;
  status: IngestionJobStatus;
  attempt: number;
  currentStage?: string | null;
};

export type DocumentRecord = {
  id: string;
  storagePath: string;
  sha256: string;
  title: string | null;
  language: SupportedLanguage | null;
  status: DocumentStatus;
  ingestionVersion: number;
};

export type ExtractedPage = {
  pageNumber: number;
  text: string;
};

export type Section = {
  pageNumber: number;
  sectionTitle: string;
  text: string;
};

export type ChunkCandidate = {
  chunkIndex: number;
  pageNumber: number;
  sectionTitle: string;
  content: string;
  language: SupportedLanguage;
};

export type ChunkWithContext = {
  chunkIndex: number;
  pageNumber: number;
  sectionTitle: string;
  content: string;
  context: string;
  language: SupportedLanguage;
};

export type ProcessJobResult = {
  status: "completed" | "partial";
  chunksProcessed: number;
  chunksTotal: number;
  documentLanguage?: SupportedLanguage;
};

export type JobProgress = {
  candidates: ChunkCandidate[] | null;
  chunksProcessed: number;
  chunksTotal: number;
  currentStage?: string | null;
};

export type PreparedChunkRecord = {
  documentId: string;
  chunkIndex: number;
  pageNumber: number;
  sectionTitle: string;
  content: string;
  context: string;
  language: SupportedLanguage;
  embedding: number[];
};

export type IngestionRuntimeSettings = {
  workerName: string;
  workerPollIntervalSeconds: number;
  ingestionBatchSize: number;
  maxRetries: number;
  chunkTargetTokens: number;
  chunkOverlapTokens: number;
  chunkMinChars: number;
  contextModel: string;
  contextEnabled: boolean;
  contextMaxChars: number;
  embeddingModel: string;
  embeddingDim: number;
  embeddingBatchSize: number;
  openAiTimeoutSeconds: number;
  openAiApiKey: string | null;
  anthropicApiKey: string | null;
  embeddingDimensions: number | null;
  ocrFallbackEnabled: boolean;
  lockTimeoutSeconds: number;
  chunksPerRun: number;
  chunkInsertBatchSize: number;
  ragStorageBucket: string;
};

function parseIntegerEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return fallback;
}

export function resolveIngestionRuntimeSettings(
  overrides: Partial<IngestionRuntimeSettings> = {},
): IngestionRuntimeSettings {
  const resolved: IngestionRuntimeSettings = {
    workerName: process.env.WORKER_NAME?.trim() || "rag-ingestion-worker",
    workerPollIntervalSeconds: parseIntegerEnv(process.env.WORKER_POLL_INTERVAL_SECONDS, 5),
    ingestionBatchSize: parseIntegerEnv(process.env.INGESTION_BATCH_SIZE, 1),
    maxRetries: parseIntegerEnv(process.env.WORKER_MAX_RETRIES, 3),
    chunkTargetTokens: parseIntegerEnv(process.env.WORKER_CHUNK_TARGET_TOKENS, 700),
    chunkOverlapTokens: parseIntegerEnv(process.env.WORKER_CHUNK_OVERLAP_TOKENS, 120),
    chunkMinChars: parseIntegerEnv(process.env.WORKER_CHUNK_MIN_CHARS, 120),
    contextModel: process.env.WORKER_CONTEXT_MODEL?.trim() || process.env.RAG_LLM_MODEL?.trim() || "gpt-4o-mini",
    contextEnabled: parseBooleanEnv(process.env.WORKER_CONTEXT_ENABLED, true),
    contextMaxChars: parseIntegerEnv(process.env.WORKER_CONTEXT_MAX_CHARS, 280),
    embeddingModel:
      process.env.WORKER_EMBEDDING_MODEL?.trim() || process.env.RAG_QUERY_EMBEDDING_MODEL?.trim() || "text-embedding-3-large",
    embeddingDim: parseIntegerEnv(process.env.WORKER_EMBEDDING_DIM, 1024),
    embeddingBatchSize: parseIntegerEnv(process.env.WORKER_EMBEDDING_BATCH_SIZE, 32),
    openAiTimeoutSeconds: parseIntegerEnv(process.env.WORKER_OPENAI_TIMEOUT_SECONDS, 40),
    openAiApiKey: process.env.OPENAI_API_KEY?.trim() || null,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || null,
    embeddingDimensions: parseIntegerEnv(process.env.WORKER_EMBEDDING_DIMENSIONS, 1024),
    ocrFallbackEnabled: parseBooleanEnv(process.env.WORKER_OCR_FALLBACK_ENABLED, true),
    lockTimeoutSeconds: parseIntegerEnv(
      process.env.WORKER_LOCK_TIMEOUT_SECONDS,
      parseIntegerEnv(process.env.INGESTION_LOCK_TIMEOUT_SECONDS, 120),
    ),
    chunksPerRun: parseIntegerEnv(process.env.WORKER_CHUNKS_PER_RUN, 5),
    chunkInsertBatchSize: parseIntegerEnv(process.env.WORKER_CHUNK_INSERT_BATCH_SIZE, 100),
    ragStorageBucket: process.env.RAG_STORAGE_BUCKET?.trim() || "documents",
    ...overrides,
  };

  if (resolved.chunkOverlapTokens >= resolved.chunkTargetTokens) {
    throw new Error("chunkOverlapTokens must be smaller than chunkTargetTokens");
  }

  return resolved;
}
