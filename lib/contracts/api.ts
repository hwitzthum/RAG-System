import type { RetrievalTrace, SupportedLanguage } from "@/lib/contracts/retrieval";
import type { WebSource } from "@/lib/web-research/types";

export type { WebSource } from "@/lib/web-research/types";

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
  documentId?: string;
  documentIds?: string[];
  languageHint?: SupportedLanguage;
  topK?: number;
};

export type QueryResponseMeta = {
  cacheHit: boolean;
  latencyMs: number;
  selectedChunkIds: string[];
  selectedDocumentIds?: string[];
  documentScopeId?: string | null;
  documentScopeIds?: string[];
  retrievalTrace?: RetrievalTrace;
  promptInjection?: {
    blockedUserQuery: boolean;
    suspiciousChunkCount: number;
    blockedChunkCount: number;
    suspiciousWebSourceCount: number;
    blockedWebSourceCount: number;
  };
  outputFilter?: {
    blocked: boolean;
    filtered: boolean;
    reasons: string[];
    redactionCount: number;
  };
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
  webSources?: WebSource[];
  queryHistoryId?: string;
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

export type ProviderByokStatusResponse = {
  vaultEnabled: boolean;
  configured: boolean;
  keyLast4: string | null;
  updatedAt: string | null;
};

export type ProviderByokUpsertRequest = {
  apiKey: string;
};

export type OpenAiByokStatusResponse = ProviderByokStatusResponse;
export type OpenAiByokUpsertRequest = ProviderByokUpsertRequest;

export type AdminRuntimeStatusResponse = {
  generatedAt: string;
  ingestionContract: {
    passed: boolean;
    requiredRpcCount: number;
    presentRpcNames: string[];
    missingRpcNames: string[];
  };
  retrievalCacheContract: {
    passed: boolean;
    requiredRpcCount: number;
    presentRpcNames: string[];
    missingRpcNames: string[];
  };
  ingestionHealth: {
    queuedCount: number;
    processingCount: number;
    recentProgressCount: number;
    staleProcessingCount: number;
    laggingProcessingCount: number;
    maxHeartbeatLagSeconds: number | null;
    processingWithoutLockCount: number;
    nonProcessingWithLockCount: number;
    inconsistentDocumentCount: number;
    readyWithoutChunksCount: number;
    stageCounts: Record<string, number>;
    effectiveDocumentCounts: Record<DocumentStatus, number>;
  };
  retrievalCache: {
    currentRetrievalVersion: number;
    totalEntries: number;
    currentVersionEntries: number;
    staleVersionEntries: number;
    expiredEntries: number;
  };
};
