import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, DocumentStatus, IngestionJobStatus } from "@/lib/supabase/database.types";

export type EnsuredDocumentQueuedJob = {
  documentId: string;
  ingestionJobId: string;
  documentStatus: DocumentStatus;
  ingestionJobStatus: IngestionJobStatus;
  storagePath: string;
  checksumSha256: string;
  jobCreated: boolean;
};

type SupabaseError = {
  message: string;
};

type RpcResponseRow = Database["public"]["Functions"]["ensure_document_queued_ingestion_job"]["Returns"][number];

export type UploadExistingJobClient = {
  runEnsureDocumentQueuedIngestionJobRpc(
    args: Database["public"]["Functions"]["ensure_document_queued_ingestion_job"]["Args"],
  ): Promise<{
    data: RpcResponseRow[] | null;
    error: SupabaseError | null;
  }>;
};

function mapRpcRow(row: RpcResponseRow): EnsuredDocumentQueuedJob {
  return {
    documentId: row.document_id,
    ingestionJobId: row.ingestion_job_id,
    documentStatus: row.document_status,
    ingestionJobStatus: row.job_status,
    storagePath: row.storage_path,
    checksumSha256: row.sha256,
    jobCreated: row.job_created,
  };
}

export function createUploadExistingJobClient(supabase: SupabaseClient<Database>): UploadExistingJobClient {
  return {
    async runEnsureDocumentQueuedIngestionJobRpc(args) {
      const { data, error } = await supabase.rpc("ensure_document_queued_ingestion_job", args);
      return { data, error };
    },
  };
}

export async function ensureDocumentQueuedIngestionJob(input: {
  client: UploadExistingJobClient;
  documentId: string;
}): Promise<EnsuredDocumentQueuedJob | null> {
  const { data, error } = await input.client.runEnsureDocumentQueuedIngestionJobRpc({
    target_document_id: input.documentId,
  });

  if (!error) {
    const row = data?.[0];
    return row ? mapRpcRow(row) : null;
  }

  if (error.message.includes("Could not find the function")) {
    throw new Error(`Required ingestion RPC ensure_document_queued_ingestion_job is unavailable (${error.message})`);
  }

  throw new Error(`Failed to ensure queued ingestion job via RPC: ${error.message}`);
}
