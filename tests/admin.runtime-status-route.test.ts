import assert from "node:assert/strict";
import test from "node:test";
import { handleAdminRuntimeStatusGet } from "../lib/admin/runtime-status-route";
import type { AdminRuntimeStatusResponse } from "../lib/contracts/api";

function buildRuntimeStatus(): AdminRuntimeStatusResponse {
  return {
    generatedAt: "2026-03-13T00:00:00.000Z",
    ingestionContract: {
      passed: true,
      requiredRpcCount: 14,
      presentRpcNames: ["claim_ingestion_jobs"],
      missingRpcNames: [],
    },
    retrievalCacheContract: {
      passed: true,
      requiredRpcCount: 3,
      presentRpcNames: ["upsert_retrieval_cache_entry"],
      missingRpcNames: [],
    },
    ingestionHealth: {
      queuedCount: 0,
      processingCount: 0,
      recentProgressCount: 0,
      staleProcessingCount: 0,
      laggingProcessingCount: 0,
      maxHeartbeatLagSeconds: null,
      processingWithoutLockCount: 0,
      nonProcessingWithLockCount: 0,
      inconsistentDocumentCount: 0,
      readyWithoutChunksCount: 0,
      stageCounts: {},
      effectiveDocumentCounts: {
        queued: 0,
        processing: 0,
        ready: 1,
        failed: 0,
      },
    },
    retrievalCache: {
      currentRetrievalVersion: 1,
      totalEntries: 0,
      currentVersionEntries: 0,
      staleVersionEntries: 0,
      expiredEntries: 0,
    },
  };
}

test("handleAdminRuntimeStatusGet returns 429 when rate limited", async () => {
  const response = await handleAdminRuntimeStatusGet({
    ipAddress: "127.0.0.1",
    dependencies: {
      consumeRateLimit: async () => ({ allowed: false, retryAfterSeconds: 12 }),
      requireAdminAuth: async () => ({ ok: true, user: { id: "admin-1", role: "admin", email: "a@example.com" } }),
      getRuntimeStatus: async () => buildRuntimeStatus(),
      logAuditEvent: () => undefined,
    },
  });

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "12");
});

test("handleAdminRuntimeStatusGet returns auth response and audits unauthorized requests", async () => {
  const audits: Array<Record<string, unknown>> = [];
  const unauthorized = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

  const response = await handleAdminRuntimeStatusGet({
    ipAddress: "127.0.0.1",
    dependencies: {
      consumeRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
      requireAdminAuth: async () => ({ ok: false, response: unauthorized }),
      getRuntimeStatus: async () => buildRuntimeStatus(),
      logAuditEvent: (event) => {
        audits.push(event as unknown as Record<string, unknown>);
      },
    },
  });

  assert.equal(response.status, 401);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.action, "admin.runtime_status");
  assert.equal(audits[0]?.outcome, "failure");
});

test("handleAdminRuntimeStatusGet returns runtime status payload for admins", async () => {
  const audits: Array<Record<string, unknown>> = [];
  const response = await handleAdminRuntimeStatusGet({
    ipAddress: "127.0.0.1",
    dependencies: {
      consumeRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
      requireAdminAuth: async () => ({ ok: true, user: { id: "admin-1", role: "admin", email: "a@example.com" } }),
      getRuntimeStatus: async () => buildRuntimeStatus(),
      logAuditEvent: (event) => {
        audits.push(event as unknown as Record<string, unknown>);
      },
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), buildRuntimeStatus());
  assert.equal(audits[0]?.outcome, "success");
});

test("handleAdminRuntimeStatusGet returns 500 when runtime status lookup fails", async () => {
  const audits: Array<Record<string, unknown>> = [];
  const response = await handleAdminRuntimeStatusGet({
    ipAddress: "127.0.0.1",
    dependencies: {
      consumeRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
      requireAdminAuth: async () => ({ ok: true, user: { id: "admin-1", role: "admin", email: "a@example.com" } }),
      getRuntimeStatus: async () => {
        throw new Error("boom");
      },
      logAuditEvent: (event) => {
        audits.push(event as unknown as Record<string, unknown>);
      },
    },
  });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Failed to load runtime status" });
  assert.equal(audits[0]?.outcome, "failure");
  assert.equal((audits[0]?.metadata as Record<string, unknown> | undefined)?.message, "boom");
});
