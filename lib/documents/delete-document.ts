import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export type DeletedDocumentResult = {
  documentId: string;
  storagePath: string | null;
  deletedJobCount: number;
  deletedChunkCount: number;
};

type SupabaseError = {
  message: string;
};

type RpcResponseRow = Database["public"]["Functions"]["delete_document_cascade"]["Returns"][number];

export type DeleteDocumentClient = {
  runDeleteDocumentCascadeRpc(args: Database["public"]["Functions"]["delete_document_cascade"]["Args"]): Promise<{
    data: RpcResponseRow[] | null;
    error: SupabaseError | null;
  }>;
};

function mapRpcRow(row: RpcResponseRow): DeletedDocumentResult {
  return {
    documentId: row.document_id,
    storagePath: row.storage_path,
    deletedJobCount: Number(row.deleted_job_count),
    deletedChunkCount: Number(row.deleted_chunk_count),
  };
}

export function createDeleteDocumentClient(supabase: SupabaseClient<Database>): DeleteDocumentClient {
  return {
    async runDeleteDocumentCascadeRpc(args) {
      const { data, error } = await supabase.rpc("delete_document_cascade", args);
      return { data, error };
    },
  };
}

export async function deleteDocumentCascade(input: {
  client: DeleteDocumentClient;
  documentId: string;
}): Promise<DeletedDocumentResult | null> {
  const { data, error } = await input.client.runDeleteDocumentCascadeRpc({
    target_document_id: input.documentId,
  });

  if (!error) {
    const row = data?.[0];
    return row ? mapRpcRow(row) : null;
  }

  if (error.message.includes("Could not find the function")) {
    throw new Error(`Required ingestion RPC delete_document_cascade is unavailable (${error.message})`);
  }

  throw new Error(`Failed to delete document via RPC: ${error.message}`);
}
