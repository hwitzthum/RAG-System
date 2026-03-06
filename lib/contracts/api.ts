import type { RetrievalTrace, SupportedLanguage } from "@/lib/contracts/retrieval";

export type Role = "admin" | "reader";

export type DocumentStatus = "queued" | "processing" | "ready" | "failed";
export type IngestionJobStatus = "queued" | "processing" | "completed" | "failed" | "dead_letter";

export type UploadResponse = {
  documentId: string;
  ingestionJobId: string;
  status: IngestionJobStatus;
  documentStatus: DocumentStatus;
  ingestionJobStatus: IngestionJobStatus;
  deduplicated: boolean;
  storagePath: string;
  checksumSha256: string;
};

export type UploadStatusResponse = {
  document: {
    id: string;
    status: DocumentStatus;
    ingestion_version: number;
    storage_path: string;
    sha256: string;
    created_at: string;
    updated_at: string;
  };
  latestIngestionJob: {
    id: string;
    status: IngestionJobStatus;
    attempt: number;
    last_error: string | null;
    locked_at: string | null;
    locked_by: string | null;
    created_at: string;
    updated_at: string;
  } | null;
};

export type QueryRequest = {
  query: string;
  conversationId?: string;
  languageHint?: SupportedLanguage;
  topK?: number;
};

export type QueryResponseMeta = {
  cacheHit: boolean;
  latencyMs: number;
  selectedChunkIds: string[];
  retrievalTrace?: RetrievalTrace;
};

export type QuerySseMetaEvent = {
  type: "meta";
  queryId: string;
  retrievalMeta: QueryResponseMeta & {
    insufficientEvidence: boolean;
    conversationId: string;
    rateLimit: {
      remaining: number;
      retryAfterSeconds: number;
    };
  };
};

export type QuerySseTokenEvent = {
  type: "token";
  queryId: string;
  token: string;
};

export type QuerySseFinalEvent = {
  type: "final";
  queryId: string;
  answer: string;
  citations: Array<{
    documentId: string;
    pageNumber: number;
    chunkId: string;
  }>;
  retrievalMeta: QuerySseMetaEvent["retrievalMeta"];
};

export type QuerySseDoneEvent = {
  type: "done";
  queryId: string;
};

export type QueryHistoryItem = {
  id: string;
  conversationId: string | null;
  query: string;
  answer: string;
  citations: Array<{
    documentId: string;
    pageNumber: number;
    chunkId: string;
  }>;
  latencyMs: number;
  cacheHit: boolean;
  createdAt: string;
};

export type QueryHistoryResponse = {
  items: QueryHistoryItem[];
};

export type OpenAiByokStatusResponse = {
  vaultEnabled: boolean;
  configured: boolean;
  keyLast4: string | null;
  updatedAt: string | null;
};

export type OpenAiByokUpsertRequest = {
  apiKey: string;
};
