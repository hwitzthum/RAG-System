import type { DocumentStatus, IngestionJobStatus } from "@/lib/supabase/database.types";

export type EffectiveStatusInput = {
  documentStatus: DocumentStatus;
  latestJobStatus: IngestionJobStatus | null;
  chunkCount: number | null;
};

export function deriveEffectiveDocumentStatus(input: EffectiveStatusInput): DocumentStatus {
  const { documentStatus, latestJobStatus, chunkCount } = input;

  if (!latestJobStatus) {
    return documentStatus;
  }

  if (latestJobStatus === "processing") {
    return "processing";
  }

  if (latestJobStatus === "queued" || latestJobStatus === "failed") {
    return "queued";
  }

  if (latestJobStatus === "dead_letter") {
    return "failed";
  }

  if (latestJobStatus === "completed") {
    if (chunkCount !== null) {
      return chunkCount > 0 ? "ready" : "failed";
    }
    return documentStatus === "ready" ? "ready" : documentStatus;
  }

  return documentStatus;
}
