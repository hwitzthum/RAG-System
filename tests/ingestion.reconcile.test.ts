import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcileDocumentStatus,
  reconcileJobState,
  type JobReconciliationSnapshot,
  type ReconciliationSnapshot,
} from "../lib/ingestion/runtime/reconcile";

function buildSnapshot(overrides: Partial<ReconciliationSnapshot>): ReconciliationSnapshot {
  return {
    documentId: "doc-1",
    title: "Test",
    documentStatus: "processing",
    latestJobStatus: "queued",
    chunkCount: 0,
    ...overrides,
  };
}

test("reconcileDocumentStatus returns queued when a processing document has a queued latest job", () => {
  const decision = reconcileDocumentStatus(buildSnapshot({}));
  assert.deepEqual(decision, {
    documentId: "doc-1",
    currentStatus: "processing",
    targetStatus: "queued",
    reason: "latest_job_queued",
  });
});

test("reconcileDocumentStatus returns ready when a completed latest job has chunks", () => {
  const decision = reconcileDocumentStatus(
    buildSnapshot({
      documentStatus: "processing",
      latestJobStatus: "completed",
      chunkCount: 8,
    }),
  );

  assert.deepEqual(decision, {
    documentId: "doc-1",
    currentStatus: "processing",
    targetStatus: "ready",
    reason: "latest_job_completed",
  });
});

test("reconcileDocumentStatus returns failed when a completed latest job has no chunks", () => {
  const decision = reconcileDocumentStatus(
    buildSnapshot({
      documentStatus: "ready",
      latestJobStatus: "completed",
      chunkCount: 0,
    }),
  );

  assert.deepEqual(decision, {
    documentId: "doc-1",
    currentStatus: "ready",
    targetStatus: "failed",
    reason: "completed_job_without_chunks",
  });
});

test("reconcileDocumentStatus returns null when document status already matches the latest job state", () => {
  const decision = reconcileDocumentStatus(
    buildSnapshot({
      documentStatus: "ready",
      latestJobStatus: "completed",
      chunkCount: 3,
    }),
  );

  assert.equal(decision, null);
});

test("reconcileDocumentStatus returns failed for dead-letter jobs", () => {
  const decision = reconcileDocumentStatus(
    buildSnapshot({
      documentStatus: "processing",
      latestJobStatus: "dead_letter",
    }),
  );

  assert.deepEqual(decision, {
    documentId: "doc-1",
    currentStatus: "processing",
    targetStatus: "failed",
    reason: "latest_job_dead_letter",
  });
});

function buildJobSnapshot(overrides: Partial<JobReconciliationSnapshot>): JobReconciliationSnapshot {
  return {
    jobId: "job-1",
    documentId: "doc-1",
    status: "processing",
    lockedAt: "2026-03-13T18:00:00Z",
    lockedBy: "worker-1",
    ...overrides,
  };
}

test("reconcileJobState requeues processing jobs without a full lock", () => {
  const decision = reconcileJobState(
    buildJobSnapshot({
      lockedAt: null,
    }),
  );

  assert.deepEqual(decision, {
    jobId: "job-1",
    documentId: "doc-1",
    currentStatus: "processing",
    targetStatus: "queued",
    clearLock: true,
    reason: "processing_without_full_lock",
  });
});

test("reconcileJobState clears stale locks from non-processing jobs", () => {
  const decision = reconcileJobState(
    buildJobSnapshot({
      status: "completed",
    }),
  );

  assert.deepEqual(decision, {
    jobId: "job-1",
    documentId: "doc-1",
    currentStatus: "completed",
    targetStatus: "completed",
    clearLock: true,
    reason: "non_processing_job_with_lock",
  });
});

test("reconcileJobState returns null for healthy processing jobs", () => {
  const decision = reconcileJobState(buildJobSnapshot({}));
  assert.equal(decision, null);
});
