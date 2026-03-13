import type { Database } from "@/lib/supabase/database.types";

type EffectiveDocumentHealthRow = Pick<
  Database["public"]["Views"]["document_effective_statuses"]["Row"],
  "raw_document_status" | "latest_job_status" | "chunk_count"
>;

type ProcessingJobHealthRow = Pick<
  Database["public"]["Tables"]["ingestion_jobs"]["Row"],
  "locked_at" | "locked_by" | "updated_at" | "current_stage"
>;

export type ProcessingHeartbeatSummary = {
  staleProcessingCount: number;
  processingWithoutLockCount: number;
  laggingProcessingCount: number;
  maxHeartbeatLagSeconds: number | null;
  stageCounts: Record<string, number>;
};

function parseTimestamp(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function countProcessingDocumentMismatches(rows: EffectiveDocumentHealthRow[]): number {
  return rows.filter((row) => row.raw_document_status === "processing" && row.latest_job_status !== "processing").length;
}

export function countReadyDocumentsWithoutChunks(rows: EffectiveDocumentHealthRow[]): number {
  return rows.filter((row) => row.raw_document_status === "ready" && row.chunk_count === 0).length;
}

export function summarizeProcessingHeartbeat(
  rows: ProcessingJobHealthRow[],
  input: {
    nowMs: number;
    staleProcessingMinutes: number;
    heartbeatLagMinutes: number;
  },
): ProcessingHeartbeatSummary {
  const staleCutoffMs = input.nowMs - input.staleProcessingMinutes * 60_000;
  const heartbeatCutoffMs = input.nowMs - input.heartbeatLagMinutes * 60_000;

  let staleProcessingCount = 0;
  let processingWithoutLockCount = 0;
  let laggingProcessingCount = 0;
  let maxHeartbeatLagSeconds: number | null = null;
  const stageCounts: Record<string, number> = {};

  for (const row of rows) {
    const lockedAtMs = parseTimestamp(row.locked_at);
    const updatedAtMs = parseTimestamp(row.updated_at);
    const hasLock = Boolean(row.locked_at && row.locked_by);
    const isStale = lockedAtMs !== null && lockedAtMs <= staleCutoffMs;
    const stage = row.current_stage?.trim() || "unknown";
    stageCounts[stage] = (stageCounts[stage] ?? 0) + 1;

    if (!hasLock) {
      processingWithoutLockCount += 1;
      continue;
    }

    if (isStale) {
      staleProcessingCount += 1;
      continue;
    }

    if (updatedAtMs !== null) {
      const lagSeconds = Math.max(0, Math.floor((input.nowMs - updatedAtMs) / 1000));
      maxHeartbeatLagSeconds = maxHeartbeatLagSeconds === null ? lagSeconds : Math.max(maxHeartbeatLagSeconds, lagSeconds);

      if (updatedAtMs <= heartbeatCutoffMs) {
        laggingProcessingCount += 1;
      }
    }
  }

  return {
    staleProcessingCount,
    processingWithoutLockCount,
    laggingProcessingCount,
    maxHeartbeatLagSeconds,
    stageCounts,
  };
}
