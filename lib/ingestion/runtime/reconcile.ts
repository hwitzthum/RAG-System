import { deriveEffectiveDocumentStatus } from "@/lib/ingestion/runtime/read-model";
import type { DocumentStatus, IngestionJobStatus } from "@/lib/supabase/database.types";

export type ReconciliationSnapshot = {
  documentId: string;
  title: string | null;
  documentStatus: DocumentStatus;
  latestJobStatus: IngestionJobStatus | null;
  chunkCount: number;
};

export type ReconciliationDecision = {
  documentId: string;
  currentStatus: DocumentStatus;
  targetStatus: DocumentStatus;
  reason: string;
};

export type JobReconciliationSnapshot = {
  jobId: string;
  documentId: string;
  status: IngestionJobStatus;
  lockedAt: string | null;
  lockedBy: string | null;
};

export type JobReconciliationDecision = {
  jobId: string;
  documentId: string;
  currentStatus: IngestionJobStatus;
  targetStatus: IngestionJobStatus;
  clearLock: boolean;
  reason: string;
};

export function reconcileDocumentStatus(snapshot: ReconciliationSnapshot): ReconciliationDecision | null {
  const targetStatus = deriveEffectiveDocumentStatus({
    documentStatus: snapshot.documentStatus,
    latestJobStatus: snapshot.latestJobStatus,
    chunkCount: snapshot.latestJobStatus ? snapshot.chunkCount : null,
  });
  if (targetStatus === snapshot.documentStatus) {
    return null;
  }

  let reason = `latest_job_${snapshot.latestJobStatus}`;
  if (snapshot.latestJobStatus === "completed" && snapshot.chunkCount === 0) {
    reason = "completed_job_without_chunks";
  }

  return {
    documentId: snapshot.documentId,
    currentStatus: snapshot.documentStatus,
    targetStatus,
    reason,
  };
}

export function reconcileJobState(snapshot: JobReconciliationSnapshot): JobReconciliationDecision | null {
  const hasLock = Boolean(snapshot.lockedAt || snapshot.lockedBy);
  const hasFullLock = Boolean(snapshot.lockedAt && snapshot.lockedBy);

  if (snapshot.status === "processing" && !hasFullLock) {
    return {
      jobId: snapshot.jobId,
      documentId: snapshot.documentId,
      currentStatus: snapshot.status,
      targetStatus: "queued",
      clearLock: true,
      reason: "processing_without_full_lock",
    };
  }

  if (snapshot.status !== "processing" && hasLock) {
    return {
      jobId: snapshot.jobId,
      documentId: snapshot.documentId,
      currentStatus: snapshot.status,
      targetStatus: snapshot.status,
      clearLock: true,
      reason: "non_processing_job_with_lock",
    };
  }

  return null;
}
