import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  DocumentRecord,
  IngestionJob,
  IngestionRuntimeSettings,
  PreparedChunkRecord,
  RuntimeLogger,
} from "@/lib/ingestion/runtime/types";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, DocumentStatus, SupportedLanguage } from "@/lib/supabase/database.types";

type ClaimedJobRow = Database["public"]["Functions"]["claim_ingestion_jobs"]["Returns"][number];
type DocumentRow = Database["public"]["Tables"]["documents"]["Row"];

export type ClaimIngestionJobsInput = {
  workerName: string;
  batchSize: number;
  lockTimeoutSeconds: number;
};

export interface IngestionRuntimeRepository {
  claimIngestionJobs(input: ClaimIngestionJobsInput): Promise<IngestionJob[]>;
  getDocument(documentId: string): Promise<DocumentRecord>;
  downloadDocument(storagePath: string): Promise<Uint8Array>;
  setDocumentStatus(documentId: string, status: DocumentStatus, language?: SupportedLanguage | null): Promise<void>;
  replaceDocumentChunks(documentId: string, chunks: PreparedChunkRecord[]): Promise<void>;
  markJobCompleted(jobId: string): Promise<void>;
  markJobFailed(job: IngestionJob, errorMessage: string): Promise<boolean>;
  invalidateRetrievalCache(): Promise<void>;
}

function toIngestionJob(row: ClaimedJobRow): IngestionJob {
  return {
    id: row.id,
    documentId: row.document_id,
    status: row.status,
    attempt: row.attempt,
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
    // Try RPC first (atomic claim with row locking), fall back to direct query
    const { data, error: rpcError } = await this.supabase.rpc("claim_ingestion_jobs", {
      worker_name: input.workerName,
      batch_size: Math.max(1, input.batchSize),
      lock_timeout_seconds: Math.max(1, input.lockTimeoutSeconds),
    });

    if (!rpcError) {
      return (data ?? []).map(toIngestionJob);
    }

    // RPC missing — fall back to direct query + update
    if (!rpcError.message.includes("Could not find the function")) {
      this.logger.warn("claim_ingestion_jobs_rpc_error_fallback", { error: rpcError.message });
    }

    const { data: jobs, error: queryError } = await this.supabase
      .from("ingestion_jobs")
      .select("id,document_id,status,attempt")
      .in("status", ["queued", "failed"])
      .is("locked_at", null)
      .order("created_at", { ascending: true })
      .limit(Math.max(1, input.batchSize));

    if (queryError) {
      throw new Error(`Failed to claim ingestion jobs: ${queryError.message}`);
    }

    if (!jobs || jobs.length === 0) {
      return [];
    }

    const now = new Date().toISOString();
    for (const job of jobs) {
      await this.supabase
        .from("ingestion_jobs")
        .update({
          status: "processing" as const,
          attempt: job.attempt + 1,
          locked_at: now,
          locked_by: input.workerName,
        })
        .eq("id", job.id);
    }

    return jobs.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      status: "processing" as const,
      attempt: row.attempt + 1,
    }));
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

  async setDocumentStatus(documentId: string, status: DocumentStatus, language?: SupportedLanguage | null): Promise<void> {
    const payload: Database["public"]["Tables"]["documents"]["Update"] = {
      status,
    };
    if (language) {
      payload.language = language;
    }

    const { error } = await this.supabase.from("documents").update(payload).eq("id", documentId);
    if (error) {
      throw new Error(`Failed to update document status: ${error.message}`);
    }
  }

  async replaceDocumentChunks(documentId: string, chunks: PreparedChunkRecord[]): Promise<void> {
    const { error: deleteError } = await this.supabase.from("document_chunks").delete().eq("document_id", documentId);
    if (deleteError) {
      throw new Error(`Failed to clear document chunks: ${deleteError.message}`);
    }

    if (chunks.length === 0) {
      return;
    }

    const batchSize = Math.max(1, this.settings.chunkInsertBatchSize);
    for (let index = 0; index < chunks.length; index += batchSize) {
      const batch = chunks.slice(index, index + batchSize);
      const rows = batch.map((chunk) => ({
        document_id: chunk.documentId,
        chunk_index: chunk.chunkIndex,
        page_number: chunk.pageNumber,
        section_title: chunk.sectionTitle,
        content: chunk.content,
        context: chunk.context,
        language: chunk.language,
        embedding: chunk.embedding,
      }));

      const { error: insertError } = await this.supabase.from("document_chunks").insert(rows);
      if (insertError) {
        throw new Error(`Failed to insert document chunks batch: ${insertError.message}`);
      }
    }
  }

  async markJobCompleted(jobId: string): Promise<void> {
    // Try RPC first (atomic job+document update), fall back to direct table update
    const { error: rpcError } = await this.supabase.rpc("complete_ingestion_job", {
      job_id: jobId,
    });

    if (!rpcError) {
      return;
    }

    // RPC missing or failed — fall back to direct update
    if (!rpcError.message.includes("Could not find the function")) {
      this.logger.warn("complete_ingestion_job_rpc_error_fallback", { jobId, error: rpcError.message });
    }

    const { error: updateError } = await this.supabase
      .from("ingestion_jobs")
      .update({
        status: "completed" as const,
        last_error: null,
        locked_at: null,
        locked_by: null,
      })
      .eq("id", jobId);

    if (updateError) {
      throw new Error(`Failed to mark ingestion job completed: ${updateError.message}`);
    }
  }

  async markJobFailed(job: IngestionJob, errorMessage: string): Promise<boolean> {
    // Try RPC first (atomic job+document update), fall back to direct table update
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

    // RPC missing or failed — fall back to direct update
    if (!rpcError.message.includes("Could not find the function")) {
      this.logger.warn("fail_ingestion_job_rpc_error_fallback", { jobId: job.id, error: rpcError.message });
    }

    const isDeadLetter = job.attempt >= this.settings.maxRetries;
    const { error: updateError } = await this.supabase
      .from("ingestion_jobs")
      .update({
        status: isDeadLetter ? ("dead_letter" as const) : ("failed" as const),
        last_error: errorMessage.slice(0, 4000),
        locked_at: null,
        locked_by: null,
      })
      .eq("id", job.id);

    if (updateError) {
      throw new Error(`Failed to mark ingestion job failed: ${updateError.message}`);
    }

    return isDeadLetter;
  }

  async invalidateRetrievalCache(): Promise<void> {
    const { error } = await this.supabase.from("retrieval_cache").delete().gt("retrieval_version", 0);
    if (error) {
      throw new Error(`Failed to invalidate retrieval cache: ${error.message}`);
    }
  }
}
