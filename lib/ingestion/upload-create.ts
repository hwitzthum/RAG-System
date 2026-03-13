import type { Database, DocumentStatus, IngestionJobStatus, SupportedLanguage } from "@/lib/supabase/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

export type CreatedDocumentWithJob = {
  documentId: string;
  ingestionJobId: string;
  documentStatus: DocumentStatus;
  ingestionJobStatus: IngestionJobStatus;
  storagePath: string;
  checksumSha256: string;
};

type SupabaseError = {
  message: string;
};

type RpcResponseRow = Database["public"]["Functions"]["create_document_with_ingestion_job"]["Returns"][number];

export type UploadCreateClient = {
  runCreateDocumentWithInitialJobRpc(args: Database["public"]["Functions"]["create_document_with_ingestion_job"]["Args"]): Promise<{
    data: RpcResponseRow[] | null;
    error: SupabaseError | null;
  }>;
};

function mapRpcRow(row: RpcResponseRow): CreatedDocumentWithJob {
  return {
    documentId: row.document_id,
    ingestionJobId: row.ingestion_job_id,
    documentStatus: row.document_status,
    ingestionJobStatus: row.job_status,
    storagePath: row.storage_path,
    checksumSha256: row.sha256,
  };
}

export function createUploadCreateClient(supabase: SupabaseClient<Database>): UploadCreateClient {
  return {
    async runCreateDocumentWithInitialJobRpc(args) {
      const { data, error } = await supabase.rpc("create_document_with_ingestion_job", args);
      return { data, error };
    },
  };
}

export async function createDocumentWithInitialJob(input: {
  client: UploadCreateClient;
  storagePath: string;
  checksumSha256: string;
  title: string | null;
  languageHint: SupportedLanguage | null;
}): Promise<CreatedDocumentWithJob | null> {
  const { data, error } = await input.client.runCreateDocumentWithInitialJobRpc({
    target_storage_path: input.storagePath,
    target_sha256: input.checksumSha256,
    target_title: input.title,
    target_language: input.languageHint,
  });

  if (!error) {
    const row = data?.[0];
    return row ? mapRpcRow(row) : null;
  }

  if (error.message.includes("Could not find the function")) {
    throw new Error(`Required ingestion RPC create_document_with_ingestion_job is unavailable (${error.message})`);
  }

  throw new Error(`Failed to create document with ingestion job via RPC: ${error.message}`);
}
