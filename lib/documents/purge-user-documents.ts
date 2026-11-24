import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  createDeleteDocumentClient,
  deleteDocumentCascade,
  type DeleteDocumentClient,
} from "./delete-document";

type SupabaseError = {
  message: string;
};

type OwnedDocumentRow = {
  id: string;
  storage_path: string | null;
};

export type PurgeUserDocumentsClient = DeleteDocumentClient & {
  listOwnedDocuments(userId: string): Promise<{
    data: OwnedDocumentRow[] | null;
    error: SupabaseError | null;
  }>;
};

export type PurgeUserDocumentsResult = {
  deletedDocumentIds: string[];
  storagePaths: string[];
};

export function createPurgeUserDocumentsClient(
  supabase: SupabaseClient<Database>,
): PurgeUserDocumentsClient {
  return {
    ...createDeleteDocumentClient(supabase),
    async listOwnedDocuments(userId) {
      const { data, error } = await supabase
        .from("documents")
        .select("id, storage_path")
        .eq("user_id", userId);
      return { data, error };
    },
  };
}

/**
 * Deletes every document owned by `userId` (rows, chunks and jobs via the
 * delete_document_cascade RPC) and returns the storage paths the caller should
 * remove from the bucket.
 *
 * This must run BEFORE the auth user is deleted: documents.user_id is
 * `ON DELETE SET NULL`, and every ownership check (RLS policies on documents,
 * document_chunks and storage.objects, plus the app-side
 * `user_id.eq.<id>,user_id.is.null` filter) treats a NULL owner as a shared
 * document. Deleting the user first would therefore publish their private
 * documents to every reader.
 *
 * Throws on any failure so the caller can abort the user deletion instead of
 * leaving private documents behind to be orphaned into the shared corpus.
 */
export async function purgeUserDocuments(input: {
  client: PurgeUserDocumentsClient;
  userId: string;
}): Promise<PurgeUserDocumentsResult> {
  const { data, error } = await input.client.listOwnedDocuments(input.userId);
  if (error) {
    throw new Error(`Failed to list user documents: ${error.message}`);
  }

  const deletedDocumentIds: string[] = [];
  const storagePaths: string[] = [];

  for (const row of data ?? []) {
    const deleted = await deleteDocumentCascade({
      client: input.client,
      documentId: row.id,
    });
    // A null result means the row was already gone (concurrent delete) — fine.
    if (!deleted) continue;
    deletedDocumentIds.push(deleted.documentId);
    const storagePath = deleted.storagePath ?? row.storage_path;
    if (storagePath) storagePaths.push(storagePath);
  }

  // Re-check: a document uploaded while we were deleting would otherwise be
  // orphaned into the shared corpus once the auth user is removed.
  const recheck = await input.client.listOwnedDocuments(input.userId);
  if (recheck.error) {
    throw new Error(`Failed to verify user documents were deleted: ${recheck.error.message}`);
  }
  if ((recheck.data ?? []).length > 0) {
    throw new Error("User still owns documents after purge; aborting user deletion");
  }

  return { deletedDocumentIds, storagePaths };
}
