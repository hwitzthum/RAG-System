import type { DocumentStatus, IngestionJobStatus } from "@/lib/supabase/database.types";

export function shouldRequeueExistingDocument(
  documentStatus: DocumentStatus,
  latestJobStatus: IngestionJobStatus | null,
): boolean {
  return documentStatus === "failed" || latestJobStatus === "dead_letter";
}

/**
 * Checksum-based dedup must not cross the per-user document access boundary.
 * A document is a valid dedup target for `requestingUserId` only if it is
 * shared (`user_id IS NULL`) or already owned by that same user. Documents
 * owned by a different user must never be surfaced — not even their
 * documentId or storage path — through the dedup path, or an attacker who
 * merely possesses a byte-identical copy of another user's private upload
 * could confirm its existence and metadata without ever being granted
 * access to it.
 */
export function isDuplicateAccessibleToUser(
  documentOwnerUserId: string | null,
  requestingUserId: string,
): boolean {
  return documentOwnerUserId === null || documentOwnerUserId === requestingUserId;
}
