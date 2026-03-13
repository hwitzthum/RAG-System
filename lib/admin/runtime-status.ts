import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/config/env";
import type { AdminRuntimeStatusResponse } from "@/lib/contracts/api";
import { REQUIRED_INGESTION_RPCS } from "@/lib/ingestion/runtime/contract";
import { REQUIRED_RETRIEVAL_CACHE_RPCS } from "@/lib/retrieval/cache-contract";
import type { Database, DocumentStatus } from "@/lib/supabase/database.types";

type RpcPresenceRow = {
  function_name: string;
  is_present: boolean;
};

export type RpcContractSummary = {
  passed: boolean;
  requiredRpcCount: number;
  presentRpcNames: string[];
  missingRpcNames: string[];
};

type AdminRuntimeSnapshotRow = Database["public"]["Functions"]["get_admin_runtime_snapshot"]["Returns"][number];

export function buildRpcContractSummary(requiredRpcNames: readonly string[], rows: RpcPresenceRow[]): RpcContractSummary {
  const presentRpcNames = rows.filter((row) => row.is_present).map((row) => row.function_name).sort();
  const available = new Set(presentRpcNames);
  const missingRpcNames = requiredRpcNames.filter((name) => !available.has(name));

  return {
    passed: missingRpcNames.length === 0,
    requiredRpcCount: requiredRpcNames.length,
    presentRpcNames,
    missingRpcNames,
  };
}

export function summarizeEffectiveDocumentCounts(
  rows: Array<{ effective_status: DocumentStatus }>,
): Record<DocumentStatus, number> {
  const counts: Record<DocumentStatus, number> = {
    queued: 0,
    processing: 0,
    ready: 0,
    failed: 0,
  };

  for (const row of rows) {
    counts[row.effective_status] += 1;
  }

  return counts;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asNullableCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const normalized: Record<string, number> = {};

  for (const [key, entry] of Object.entries(record)) {
    normalized[key] = asCount(entry);
  }

  return normalized;
}

function asDocumentStatusCounts(value: unknown): Record<DocumentStatus, number> {
  const counts = asNumberRecord(value);
  return {
    queued: counts.queued ?? 0,
    processing: counts.processing ?? 0,
    ready: counts.ready ?? 0,
    failed: counts.failed ?? 0,
  };
}

export async function getAdminRuntimeStatus(
  supabase: SupabaseClient<Database>,
  input?: {
    noProgressMinutes?: number;
    staleProcessingMinutes?: number;
    heartbeatLagMinutes?: number;
    nowMs?: number;
  },
): Promise<AdminRuntimeStatusResponse> {
  const nowMs = input?.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const noProgressMinutes = input?.noProgressMinutes ?? 15;
  const staleProcessingMinutes = input?.staleProcessingMinutes ?? 20;
  const heartbeatLagMinutes = input?.heartbeatLagMinutes ?? 5;

  const [
    ingestionContractResult,
    retrievalContractResult,
    snapshotResult,
  ] = await Promise.all([
    supabase.rpc("check_required_ingestion_rpcs", {
      required_functions: [...REQUIRED_INGESTION_RPCS],
    }),
    supabase.rpc("check_required_ingestion_rpcs", {
      required_functions: [...REQUIRED_RETRIEVAL_CACHE_RPCS],
    }),
    supabase.rpc("get_admin_runtime_snapshot", {
      target_now: nowIso,
      target_no_progress_minutes: noProgressMinutes,
      target_stale_processing_minutes: staleProcessingMinutes,
      target_heartbeat_lag_minutes: heartbeatLagMinutes,
      target_current_retrieval_version: env.RAG_RETRIEVAL_VERSION,
    }),
  ]);

  for (const result of [ingestionContractResult, retrievalContractResult, snapshotResult]) {
    if (result.error) {
      throw new Error(result.error.message);
    }
  }

  const snapshot = (snapshotResult.data?.[0] ?? null) as AdminRuntimeSnapshotRow | null;
  if (!snapshot) {
    throw new Error("get_admin_runtime_snapshot returned no row");
  }

  return {
    generatedAt: nowIso,
    ingestionContract: buildRpcContractSummary(REQUIRED_INGESTION_RPCS, (ingestionContractResult.data ?? []) as RpcPresenceRow[]),
    retrievalCacheContract: buildRpcContractSummary(
      REQUIRED_RETRIEVAL_CACHE_RPCS,
      (retrievalContractResult.data ?? []) as RpcPresenceRow[],
    ),
    ingestionHealth: {
      queuedCount: asCount(snapshot.queued_count),
      processingCount: asCount(snapshot.processing_count),
      recentProgressCount: asCount(snapshot.recent_progress_count),
      staleProcessingCount: asCount(snapshot.stale_processing_count),
      laggingProcessingCount: asCount(snapshot.lagging_processing_count),
      maxHeartbeatLagSeconds: asNullableCount(snapshot.max_heartbeat_lag_seconds),
      processingWithoutLockCount: asCount(snapshot.processing_without_lock_count),
      nonProcessingWithLockCount: asCount(snapshot.non_processing_with_lock_count),
      inconsistentDocumentCount: asCount(snapshot.inconsistent_document_count),
      readyWithoutChunksCount: asCount(snapshot.ready_without_chunks_count),
      stageCounts: asNumberRecord(snapshot.stage_counts),
      effectiveDocumentCounts: asDocumentStatusCounts(snapshot.effective_document_counts),
    },
    retrievalCache: {
      currentRetrievalVersion: env.RAG_RETRIEVAL_VERSION,
      totalEntries: asCount(snapshot.total_cache_entries),
      currentVersionEntries: asCount(snapshot.current_version_cache_entries),
      staleVersionEntries: asCount(snapshot.stale_version_cache_entries),
      expiredEntries: asCount(snapshot.expired_cache_entries),
    },
  };
}
