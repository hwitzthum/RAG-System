import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ChunkCandidate,
  DocumentRecord,
  IngestionJob,
  IngestionRuntimeSettings,
  JobProgress,
  PreparedChunkRecord,
  RuntimeLogger,
} from "@/lib/ingestion/runtime/types";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, SupportedLanguage } from "@/lib/supabase/database.types";

type ClaimedJobRow = Database["public"]["Functions"]["claim_ingestion_jobs"]["Returns"][number];
type DocumentRow = Database["public"]["Tables"]["documents"]["Row"];
type ReplaceDocumentChunksRow = Database["public"]["Functions"]["replace_document_chunks"]["Returns"][number];
type AppendDocumentChunksRow = Database["public"]["Functions"]["append_document_chunks"]["Returns"][number];

export type ClaimIngestionJobsInput = {
  workerName: string;
  batchSize: number;
  lockTimeoutSeconds: number;
  maxRetries?: number;
};

export interface IngestionRuntimeRepository {
  claimIngestionJobs(input: ClaimIngestionJobsInput): Promise<IngestionJob[]>;
  getDocument(documentId: string): Promise<DocumentRecord>;
  downloadDocument(storagePath: string): Promise<Uint8Array>;
  replaceDocumentChunks(documentId: string, chunks: PreparedChunkRecord[]): Promise<void>;
  markJobCompleted(jobId: string, language?: SupportedLanguage | null): Promise<void>;
  markJobFailed(job: IngestionJob, errorMessage: string): Promise<boolean>;
  invalidateRetrievalCache(): Promise<void>;
  saveChunkCandidates(jobId: string, chunks: ChunkCandidate[], total: number): Promise<void>;
  loadJobProgress(jobId: string): Promise<JobProgress>;
  updateJobStage(jobId: string, stage: string): Promise<void>;
  updateJobProgress(jobId: string, chunksProcessed: number): Promise<void>;
  yieldJob(jobId: string): Promise<void>;
  insertChunkBatch(documentId: string, chunks: PreparedChunkRecord[]): Promise<void>;
}

function isMissingRpcFunction(errorMessage: string): boolean {
  return errorMessage.includes("Could not find the function");
}

function buildMissingRpcError(functionName: string, details?: string): Error {
  const suffix = details ? ` (${details})` : "";
  return new Error(`Required ingestion RPC ${functionName} is unavailable${suffix}`);
}

function toIngestionJob(row: ClaimedJobRow): IngestionJob {
  return {
    id: row.id,
    documentId: row.document_id,
    status: row.status,
    attempt: row.attempt,
    currentStage: "claimed",
  };
}

function toDocumentRecord(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    storagePath: row.storage_path,
    sha256: row.sha256,
    title: row.title,
    language: row.language,
    status: row.status,
    ingestionVersion: row.ingestion_version,
  };
}

function toReplaceDocumentChunkRpcChunk(chunk: PreparedChunkRecord): Record<string, unknown> {
  return {
    chunk_index: chunk.chunkIndex,
    page_number: chunk.pageNumber,
    section_title: chunk.sectionTitle,
    content: chunk.content,
    context: chunk.context,
    language: chunk.language,
    embedding: chunk.embedding,
  };
}

async function toUint8Array(payload: unknown): Promise<Uint8Array> {
  if (!payload) {
    throw new Error("Storage download returned empty payload");
  }

  if (payload instanceof Uint8Array) {
    return payload;
  }

  if (payload instanceof ArrayBuffer) {
    return new Uint8Array(payload);
  }

  if (typeof Blob !== "undefined" && payload instanceof Blob) {
    return new Uint8Array(await payload.arrayBuffer());
  }

  if (Buffer.isBuffer(payload)) {
    return new Uint8Array(payload);
  }

  if (typeof payload === "object" && "arrayBuffer" in payload) {
    const candidate = payload as { arrayBuffer: () => Promise<ArrayBuffer> };
    return new Uint8Array(await candidate.arrayBuffer());
  }

  throw new Error("Unsupported storage download payload");
}

export class SupabaseIngestionRuntimeRepository implements IngestionRuntimeRepository {
  private readonly supabase: SupabaseClient<Database>;
  private readonly settings: IngestionRuntimeSettings;
  private readonly logger: RuntimeLogger;

  constructor(input: {
    settings: IngestionRuntimeSettings;
    logger: RuntimeLogger;
    supabase?: SupabaseClient<Database>;
  }) {
    this.settings = input.settings;
    this.logger = input.logger;
    this.supabase = input.supabase ?? getSupabaseAdminClient();
  }

  async claimIngestionJobs(input: ClaimIngestionJobsInput): Promise<IngestionJob[]> {
    const { data, error: rpcError } = await this.supabase.rpc("claim_ingestion_jobs", {
      worker_name: input.workerName,
      batch_size: Math.max(1, input.batchSize),
      lock_timeout_seconds: Math.max(1, input.lockTimeoutSeconds),
      max_retries: input.maxRetries ?? this.settings.maxRetries,
    });

    if (!rpcError) {
      return (data ?? []).map(toIngestionJob);
    }

    if (isMissingRpcFunction(rpcError.message)) {
      throw buildMissingRpcError("claim_ingestion_jobs", rpcError.message);
    }

    throw new Error(`Failed to claim ingestion jobs via RPC: ${rpcError.message}`);
  }

  async getDocument(documentId: string): Promise<DocumentRecord> {
    const { data, error } = await this.supabase
      .from("documents")
      .select("id,storage_path,sha256,title,language,status,ingestion_version")
      .eq("id", documentId)
      .single<DocumentRow>();

    if (error) {
      throw new Error(`Failed to load document: ${error.message}`);
    }

    return toDocumentRecord(data);
  }

  async downloadDocument(storagePath: string): Promise<Uint8Array> {
    const { data, error } = await this.supabase.storage
      .from(this.settings.ragStorageBucket)
      .download(storagePath);

    if (error) {
      throw new Error(`Failed to download document from storage: ${error.message}`);
    }

    return toUint8Array(data);
  }

  async replaceDocumentChunks(documentId: string, chunks: PreparedChunkRecord[]): Promise<void> {
    const { data, error: rpcError } = await this.supabase.rpc("replace_document_chunks", {
      target_document_id: documentId,
      target_chunks: chunks.map(toReplaceDocumentChunkRpcChunk),
    });

    if (!rpcError) {
      const row = data?.[0] as ReplaceDocumentChunksRow | undefined;
      if (!row) {
        throw new Error(`replace_document_chunks returned no row for ${documentId}`);
      }
      return;
    }

    if (isMissingRpcFunction(rpcError.message)) {
      throw buildMissingRpcError("replace_document_chunks", rpcError.message);
    }

    throw new Error(`Failed to replace document chunks via RPC: ${rpcError.message}`);
  }

  async markJobCompleted(jobId: string, language?: SupportedLanguage | null): Promise<void> {
    const { error: rpcError } = await this.supabase.rpc("complete_ingestion_job", {
      job_id: jobId,
      document_language: language ?? null,
    });

    if (!rpcError) {
      return;
    }

    if (isMissingRpcFunction(rpcError.message)) {
      throw buildMissingRpcError("complete_ingestion_job", rpcError.message);
    }

    throw new Error(`Failed to complete ingestion job via RPC: ${rpcError.message}`);
  }

  async markJobFailed(job: IngestionJob, errorMessage: string): Promise<boolean> {
    const { data, error: rpcError } = await this.supabase.rpc("fail_ingestion_job", {
      job_id: job.id,
      error_text: errorMessage,
      max_retries: this.settings.maxRetries,
    });

    if (!rpcError) {
      const row = data?.[0];
      if (!row) {
        this.logger.warn("ingestion_job_fail_noop", { jobId: job.id });
        return false;
      }
      return row.dead_letter;
    }

    if (isMissingRpcFunction(rpcError.message)) {
      throw buildMissingRpcError("fail_ingestion_job", rpcError.message);
    }

    throw new Error(`Failed to fail ingestion job via RPC: ${rpcError.message}`);
  }

  async invalidateRetrievalCache(): Promise<void> {
    const { data, error: rpcError } = await this.supabase.rpc("invalidate_retrieval_cache");

    if (!rpcError) {
      if (!data?.[0]) {
        throw new Error("invalidate_retrieval_cache returned no row");
      }
      return;
    }

    if (isMissingRpcFunction(rpcError.message)) {
      throw buildMissingRpcError("invalidate_retrieval_cache", rpcError.message);
    }

    throw new Error(`Failed to invalidate retrieval cache via RPC: ${rpcError.message}`);
  }

  async saveChunkCandidates(jobId: string, chunks: ChunkCandidate[], total: number): Promise<void> {
    const { error: rpcError } = await this.supabase.rpc("checkpoint_ingestion_job", {
      target_job_id: jobId,
      target_chunk_candidates: chunks as unknown as Record<string, unknown>[],
      target_chunks_total: total,
      target_chunks_processed: 0,
      target_stage: "chunked",
    });

    if (!rpcError) {
      return;
    }

    if (isMissingRpcFunction(rpcError.message)) {
      throw buildMissingRpcError("checkpoint_ingestion_job", rpcError.message);
    }

    throw new Error(`Failed to save chunk candidates via RPC: ${rpcError.message}`);
  }

  async loadJobProgress(jobId: string): Promise<JobProgress> {
    const { data, error } = await this.supabase
      .from("ingestion_jobs")
      .select("chunk_candidates,chunks_total,chunks_processed,current_stage")
      .eq("id", jobId)
      .single();

    if (error) {
      throw new Error(`Failed to load job progress: ${error.message}`);
    }

    const candidates = data.chunk_candidates
      ? (data.chunk_candidates as unknown as ChunkCandidate[])
      : null;

    return {
      candidates,
      chunksProcessed: data.chunks_processed,
      chunksTotal: data.chunks_total,
      currentStage: data.current_stage,
    };
  }

  async updateJobStage(jobId: string, stage: string): Promise<void> {
    const { error: rpcError } = await this.supabase.rpc("checkpoint_ingestion_job", {
      target_job_id: jobId,
      target_stage: stage,
    });

    if (!rpcError) {
      return;
    }

    if (isMissingRpcFunction(rpcError.message)) {
      throw buildMissingRpcError("checkpoint_ingestion_job", rpcError.message);
    }

    throw new Error(`Failed to update job stage via RPC: ${rpcError.message}`);
  }

  async updateJobProgress(jobId: string, chunksProcessed: number): Promise<void> {
    const { error: rpcError } = await this.supabase.rpc("checkpoint_ingestion_job", {
      target_job_id: jobId,
      target_chunks_processed: chunksProcessed,
    });

    if (!rpcError) {
      return;
    }

    if (isMissingRpcFunction(rpcError.message)) {
      throw buildMissingRpcError("checkpoint_ingestion_job", rpcError.message);
    }

    throw new Error(`Failed to update job progress via RPC: ${rpcError.message}`);
  }

  async yieldJob(jobId: string): Promise<void> {
    const { error: rpcError } = await this.supabase.rpc("yield_ingestion_job", {
      target_job_id: jobId,
    });

    if (!rpcError) {
      return;
    }

    if (isMissingRpcFunction(rpcError.message)) {
      throw buildMissingRpcError("yield_ingestion_job", rpcError.message);
    }

    throw new Error(`Failed to yield job via RPC: ${rpcError.message}`);
  }

  async insertChunkBatch(documentId: string, chunks: PreparedChunkRecord[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }

    const { data, error: rpcError } = await this.supabase.rpc("append_document_chunks", {
      target_document_id: documentId,
      target_chunks: chunks.map(toReplaceDocumentChunkRpcChunk),
    });

    if (!rpcError) {
      const row = data?.[0] as AppendDocumentChunksRow | undefined;
      if (!row) {
        throw new Error(`append_document_chunks returned no row for ${documentId}`);
      }
      return;
    }

    if (isMissingRpcFunction(rpcError.message)) {
      throw buildMissingRpcError("append_document_chunks", rpcError.message);
    }

    throw new Error(`Failed to append document chunks via RPC: ${rpcError.message}`);
  }
}
