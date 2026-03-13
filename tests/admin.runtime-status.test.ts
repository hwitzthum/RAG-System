import assert from "node:assert/strict";
import test from "node:test";

function ensureRuntimeStatusEnv(): void {
  process.env.SUPABASE_URL ??= "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY ??= "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-key";
  process.env.OPENAI_API_KEY ??= "test-openai-key";
}

async function loadRuntimeStatusModule() {
  ensureRuntimeStatusEnv();
  return import("../lib/admin/runtime-status");
}

test("buildRpcContractSummary reports missing RPCs against the required set", () => {
  return (async () => {
    const { buildRpcContractSummary } = await loadRuntimeStatusModule();
  const summary = buildRpcContractSummary(
    ["rpc_a", "rpc_b", "rpc_c"],
    [
      { function_name: "rpc_a", is_present: true },
      { function_name: "rpc_b", is_present: false },
    ],
  );

  assert.deepEqual(summary, {
    passed: false,
    requiredRpcCount: 3,
    presentRpcNames: ["rpc_a"],
    missingRpcNames: ["rpc_b", "rpc_c"],
  });
  })();
});

test("summarizeEffectiveDocumentCounts tallies effective document statuses", () => {
  return (async () => {
    const { summarizeEffectiveDocumentCounts } = await loadRuntimeStatusModule();
  const counts = summarizeEffectiveDocumentCounts([
    { effective_status: "queued" },
    { effective_status: "ready" },
    { effective_status: "ready" },
    { effective_status: "failed" },
  ]);

  assert.deepEqual(counts, {
    queued: 1,
    processing: 0,
    ready: 2,
    failed: 1,
  });
  })();
});

test("getAdminRuntimeStatus maps the snapshot RPC into the admin response shape", () => {
  return (async () => {
    const { getAdminRuntimeStatus } = await loadRuntimeStatusModule();

    const fakeSupabase = {
      rpc(fn: string, args?: Record<string, unknown>) {
        if (fn === "check_required_ingestion_rpcs") {
          const requiredFunctions = (args?.required_functions as string[] | undefined) ?? [];
          return Promise.resolve({
            data: requiredFunctions.map((name) => ({ function_name: name, is_present: true })),
            error: null,
          });
        }

        if (fn === "get_admin_runtime_snapshot") {
          return Promise.resolve({
            data: [
              {
                queued_count: 2,
                processing_count: 1,
                recent_progress_count: 4,
                stale_processing_count: 0,
                lagging_processing_count: 1,
                max_heartbeat_lag_seconds: 42,
                processing_without_lock_count: 0,
                non_processing_with_lock_count: 0,
                inconsistent_document_count: 1,
                ready_without_chunks_count: 0,
                stage_counts: { embedding: 1 },
                effective_document_counts: { queued: 2, processing: 1, ready: 3, failed: 0 },
                total_cache_entries: 7,
                current_version_cache_entries: 5,
                stale_version_cache_entries: 2,
                expired_cache_entries: 1,
              },
            ],
            error: null,
          });
        }

        throw new Error(`Unexpected RPC: ${fn}`);
      },
    };

    const status = await getAdminRuntimeStatus(fakeSupabase as never, { nowMs: Date.parse("2026-03-13T12:00:00.000Z") });

    assert.equal(status.generatedAt, "2026-03-13T12:00:00.000Z");
    assert.equal(status.ingestionContract.passed, true);
    assert.equal(status.retrievalCacheContract.passed, true);
    assert.deepEqual(status.ingestionHealth, {
      queuedCount: 2,
      processingCount: 1,
      recentProgressCount: 4,
      staleProcessingCount: 0,
      laggingProcessingCount: 1,
      maxHeartbeatLagSeconds: 42,
      processingWithoutLockCount: 0,
      nonProcessingWithLockCount: 0,
      inconsistentDocumentCount: 1,
      readyWithoutChunksCount: 0,
      stageCounts: { embedding: 1 },
      effectiveDocumentCounts: {
        queued: 2,
        processing: 1,
        ready: 3,
        failed: 0,
      },
    });
    assert.deepEqual(status.retrievalCache, {
      currentRetrievalVersion: 1,
      totalEntries: 7,
      currentVersionEntries: 5,
      staleVersionEntries: 2,
      expiredEntries: 1,
    });
  })();
});
