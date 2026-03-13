import assert from "node:assert/strict";
import test from "node:test";
import { applyDocumentReconciliation, applyJobReconciliation, type ReconcileWriteClient } from "../lib/ingestion/runtime/reconcile-write";

test("applyDocumentReconciliation calls the reconciliation RPC with optimistic status matching", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client: ReconcileWriteClient = {
    async runReconcileDocumentStatusRpc(args) {
      calls.push({ fn: "document", args });
      return {
        data: [
          {
            document_id: "doc-1",
            previous_status: "processing",
            document_status: "queued",
            updated_at: "2026-03-13T00:00:00.000Z",
          },
        ],
        error: null,
      };
    },
    async runReconcileIngestionJobStateRpc() {
      throw new Error("job RPC should not be used");
    },
  };

  const applied = await applyDocumentReconciliation(client, {
    documentId: "doc-1",
    currentStatus: "processing",
    targetStatus: "queued",
    reason: "latest_job_queued",
  });

  assert.equal(applied, true);
  assert.deepEqual(calls, [
    {
      fn: "document",
      args: {
        target_document_id: "doc-1",
        expected_current_status: "processing",
        target_status: "queued",
      },
    },
  ]);
});

test("applyJobReconciliation requeues the document atomically for broken processing locks", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client: ReconcileWriteClient = {
    async runReconcileDocumentStatusRpc() {
      throw new Error("document RPC should not be used");
    },
    async runReconcileIngestionJobStateRpc(args) {
      calls.push({ fn: "job", args });
      return {
        data: [
          {
            job_id: "job-1",
            document_id: "doc-1",
            previous_job_status: "processing",
            job_status: "queued",
            document_status: "queued",
            updated_at: "2026-03-13T00:00:00.000Z",
          },
        ],
        error: null,
      };
    },
  };

  const applied = await applyJobReconciliation(client, {
    jobId: "job-1",
    documentId: "doc-1",
    currentStatus: "processing",
    targetStatus: "queued",
    clearLock: true,
    reason: "processing_without_full_lock",
  });

  assert.equal(applied, true);
  assert.deepEqual(calls, [
    {
      fn: "job",
      args: {
        target_job_id: "job-1",
        expected_current_status: "processing",
        target_job_status: "queued",
        clear_lock: true,
        target_document_status: "queued",
        expected_document_current_status: "processing",
      },
    },
  ]);
});

test("applyJobReconciliation returns false when the reconciliation RPC reports no row update", async () => {
  const client: ReconcileWriteClient = {
    async runReconcileDocumentStatusRpc() {
      throw new Error("document RPC should not be used");
    },
    async runReconcileIngestionJobStateRpc() {
      return {
        data: [],
        error: null,
      };
    },
  };

  const applied = await applyJobReconciliation(client, {
    jobId: "job-1",
    documentId: "doc-1",
    currentStatus: "completed",
    targetStatus: "completed",
    clearLock: true,
    reason: "non_processing_job_with_lock",
  });

  assert.equal(applied, false);
});
