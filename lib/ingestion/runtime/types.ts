import { resolveIngestionEnv } from "@/lib/config/ingestion-env";
import type {
  DocumentStatus,
  IngestionJobStatus,
  SupportedLanguage,
} from "@/lib/supabase/database.types";

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
  userId: string | null;
  storagePath: string;
  sha256: string;
  title: string | null;
  summary: string | null;
  language: SupportedLanguage | null;
  status: DocumentStatus;
  ingestionVersion: number;
};

export type ExtractionMethod = "pdfjs" | "ocr" | "byte_scrape";

export type ExtractedPage = {
  pageNumber: number;
  text: string;
  /** How the text was obtained. Absent on injected test fixtures. */
  method?: ExtractionMethod;
  /**
   * Whether layout reconstruction replaced any run of lines with a Markdown
   * pipe table. Provenance only, so a bad reconstruction is attributable
   * rather than invisible.
   */
  hasTables?: boolean;
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
  // Optional: absent on candidates checkpointed before provenance tracking;
  // such chunks store NULL and are re-stamped on the next re-ingest.
  extractionMethod?: ExtractionMethod;
  tokenCount?: number;
};

export type ChunkWithContext = ChunkCandidate & {
  context: string;
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
  extractionMethod: ExtractionMethod | null;
  /** "<model>@<dimensions>", e.g. "text-embedding-3-large@1024". */
  embeddingModel: string;
  tokenCount: number | null;
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
  /** Vision model that transcribes pages without a text layer. */
  ocrModel: string;
  lockTimeoutSeconds: number;
  chunksPerRun: number;
  chunkInsertBatchSize: number;
  ragStorageBucket: string;
};

export function resolveIngestionRuntimeSettings(
  overrides: Partial<IngestionRuntimeSettings> = {},
): IngestionRuntimeSettings {
  const resolved: IngestionRuntimeSettings = {
    ...resolveIngestionEnv(),
    ...overrides,
  };

  if (resolved.chunkOverlapTokens >= resolved.chunkTargetTokens) {
    throw new Error(
      "chunkOverlapTokens must be smaller than chunkTargetTokens",
    );
  }

  return resolved;
}
