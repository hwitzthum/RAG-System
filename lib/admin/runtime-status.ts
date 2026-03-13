import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/config/env";
import { REQUIRED_INGESTION_RPCS } from "@/lib/ingestion/runtime/contract";
import {
  countProcessingDocumentMismatches,
  countReadyDocumentsWithoutChunks,
  summarizeProcessingHeartbeat,
} from "@/lib/ingestion/runtime/health-view";
import { REQUIRED_RETRIEVAL_CACHE_RPCS } from "@/lib/retrieval/cache-contract";
import type { Database, DocumentStatus, IngestionJobStatus } from "@/lib/supabase/database.types";

type RpcPresenceRow = {
  function_name: string;
  is_present: boolean;
};

type EffectiveDocumentRow = Pick<
  Database["public"]["Views"]["document_effective_statuses"]["Row"],
  "effective_status" | "raw_document_status" | "latest_job_status" | "chunk_count"
>;

export type RpcContractSummary = {
  passed: boolean;
  requiredRpcCount: number;
  presentRpcNames: string[];
  missingRpcNames: string[];
};

export type AdminRuntimeStatusResponse = {
  generatedAt: string;
  ingestionContract: RpcContractSummary;
  retrievalCacheContract: RpcContractSummary;
  ingestionHealth: {
    queuedCount: number;
    processingCount: number;
    recentProgressCount: number;
    staleProcessingCount: number;
    laggingProcessingCount: number;
    maxHeartbeatLagSeconds: number | null;
    processingWithoutLockCount: number;
    nonProcessingWithLockCount: number;
    inconsistentDocumentCount: number;
    readyWithoutChunksCount: number;
    stageCounts: Record<string, number>;
    effectiveDocumentCounts: Record<DocumentStatus, number>;
  };
  retrievalCache: {
    currentRetrievalVersion: number;
    totalEntries: number;
    currentVersionEntries: number;
    staleVersionEntries: number;
    expiredEntries: number;
  };
};

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
  rows: Array<Pick<EffectiveDocumentRow, "effective_status">>,
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
  const progressCutoffIso = new Date(nowMs - noProgressMinutes * 60_000).toISOString();

  const [
    ingestionContractResult,
    retrievalContractResult,
    queuedCountResult,
    processingRowsResult,
    recentProgressResult,
    effectiveDocumentsResult,
    nonProcessingWithLockResult,
    totalCacheResult,
    currentVersionCacheResult,
    staleVersionCacheResult,
    expiredCacheResult,
  ] = await Promise.all([
    supabase.rpc("check_required_ingestion_rpcs", {
      required_functions: [...REQUIRED_INGESTION_RPCS],
    }),
    supabase.rpc("check_required_ingestion_rpcs", {
      required_functions: [...REQUIRED_RETRIEVAL_CACHE_RPCS],
    }),
    supabase.from("ingestion_jobs").select("id", { head: true, count: "exact" }).eq("status", "queued"),
    supabase.from("ingestion_jobs").select("locked_at,locked_by,updated_at,current_stage").eq("status", "processing"),
    supabase
      .from("ingestion_jobs")
      .select("id", { head: true, count: "exact" })
      .in("status", ["processing", "completed", "failed", "dead_letter"] satisfies IngestionJobStatus[])
      .gte("updated_at", progressCutoffIso),
    supabase.from("document_effective_statuses").select("effective_status,raw_document_status,latest_job_status,chunk_count"),
    supabase
      .from("ingestion_jobs")
      .select("id", { head: true, count: "exact" })
      .in("status", ["queued", "failed", "dead_letter", "completed"] satisfies IngestionJobStatus[])
      .not("locked_at", "is", null),
    supabase.from("retrieval_cache").select("cache_key", { head: true, count: "exact" }),
    supabase
      .from("retrieval_cache")
      .select("cache_key", { head: true, count: "exact" })
      .eq("retrieval_version", env.RAG_RETRIEVAL_VERSION),
    supabase
      .from("retrieval_cache")
      .select("cache_key", { head: true, count: "exact" })
      .lt("retrieval_version", env.RAG_RETRIEVAL_VERSION),
    supabase.from("retrieval_cache").select("cache_key", { head: true, count: "exact" }).lte("expires_at", nowIso),
  ]);

  for (const result of [
    ingestionContractResult,
    retrievalContractResult,
    queuedCountResult,
    processingRowsResult,
    recentProgressResult,
    effectiveDocumentsResult,
    nonProcessingWithLockResult,
    totalCacheResult,
    currentVersionCacheResult,
    staleVersionCacheResult,
    expiredCacheResult,
  ]) {
    if (result.error) {
      throw new Error(result.error.message);
    }
  }

  const effectiveDocumentRows = (effectiveDocumentsResult.data ?? []) as EffectiveDocumentRow[];
  const processingRows = (processingRowsResult.data ?? []) as Array<{
    locked_at: string | null;
    locked_by: string | null;
    updated_at: string;
    current_stage: string | null;
  }>;

  const heartbeatSummary = summarizeProcessingHeartbeat(processingRows, {
    nowMs,
    staleProcessingMinutes,
    heartbeatLagMinutes,
  });

  return {
    generatedAt: nowIso,
    ingestionContract: buildRpcContractSummary(REQUIRED_INGESTION_RPCS, (ingestionContractResult.data ?? []) as RpcPresenceRow[]),
    retrievalCacheContract: buildRpcContractSummary(
      REQUIRED_RETRIEVAL_CACHE_RPCS,
      (retrievalContractResult.data ?? []) as RpcPresenceRow[],
    ),
    ingestionHealth: {
      queuedCount: queuedCountResult.count ?? 0,
      processingCount: processingRows.length,
      recentProgressCount: recentProgressResult.count ?? 0,
      staleProcessingCount: heartbeatSummary.staleProcessingCount,
      laggingProcessingCount: heartbeatSummary.laggingProcessingCount,
      maxHeartbeatLagSeconds: heartbeatSummary.maxHeartbeatLagSeconds,
      processingWithoutLockCount: heartbeatSummary.processingWithoutLockCount,
      nonProcessingWithLockCount: nonProcessingWithLockResult.count ?? 0,
      inconsistentDocumentCount: countProcessingDocumentMismatches(effectiveDocumentRows),
      readyWithoutChunksCount: countReadyDocumentsWithoutChunks(effectiveDocumentRows),
      stageCounts: heartbeatSummary.stageCounts,
      effectiveDocumentCounts: summarizeEffectiveDocumentCounts(effectiveDocumentRows),
    },
    retrievalCache: {
      currentRetrievalVersion: env.RAG_RETRIEVAL_VERSION,
      totalEntries: totalCacheResult.count ?? 0,
      currentVersionEntries: currentVersionCacheResult.count ?? 0,
      staleVersionEntries: staleVersionCacheResult.count ?? 0,
      expiredEntries: expiredCacheResult.count ?? 0,
    },
  };
}
