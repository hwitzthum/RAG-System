import type { DocumentStatus, IngestionJobStatus } from "@/lib/supabase/database.types";

export function shouldRequeueExistingDocument(
  documentStatus: DocumentStatus,
  latestJobStatus: IngestionJobStatus | null,
): boolean {
  return documentStatus === "failed" || latestJobStatus === "dead_letter";
}
