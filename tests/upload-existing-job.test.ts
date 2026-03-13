import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureDocumentQueuedIngestionJob,
  type UploadExistingJobClient,
} from "../lib/ingestion/upload-existing-job";

function createRpcSuccessClient(jobCreated: boolean): UploadExistingJobClient {
  return {
    async runEnsureDocumentQueuedIngestionJobRpc() {
      return {
        data: [
          {
            document_id: "doc-1",
            ingestion_job_id: "job-1",
            document_status: "queued",
            job_status: "queued",
            ingestion_version: 1,
            storage_path: "uploads/doc-1.pdf",
            sha256: "sha-1",
            idempotency_key: "sha-1:v1",
            job_created: jobCreated,
            updated_at: "2026-03-13T00:00:00.000Z",
          },
        ],
        error: null,
      };
    },
  };
}

test("ensureDocumentQueuedIngestionJob returns mapped RPC rows", async () => {
  const result = await ensureDocumentQueuedIngestionJob({
    client: createRpcSuccessClient(true),
    documentId: "doc-1",
  });

  assert.deepEqual(result, {
    documentId: "doc-1",
    ingestionJobId: "job-1",
    documentStatus: "queued",
    ingestionJobStatus: "queued",
    storagePath: "uploads/doc-1.pdf",
    checksumSha256: "sha-1",
    jobCreated: true,
  });
});

test("ensureDocumentQueuedIngestionJob preserves existing-job responses", async () => {
  const result = await ensureDocumentQueuedIngestionJob({
    client: createRpcSuccessClient(false),
    documentId: "doc-1",
  });

  assert.equal(result?.jobCreated, false);
  assert.equal(result?.ingestionJobStatus, "queued");
});

test("ensureDocumentQueuedIngestionJob returns null when RPC reports no row", async () => {
  const client: UploadExistingJobClient = {
    async runEnsureDocumentQueuedIngestionJobRpc() {
      return { data: [], error: null };
    },
  };

  const result = await ensureDocumentQueuedIngestionJob({
    client,
    documentId: "doc-1",
  });

  assert.equal(result, null);
});

test("ensureDocumentQueuedIngestionJob throws when the RPC is unavailable", async () => {
  const client: UploadExistingJobClient = {
    async runEnsureDocumentQueuedIngestionJobRpc() {
      return {
        data: null,
        error: { message: "Could not find the function public.ensure_document_queued_ingestion_job" },
      };
    },
  };

  await assert.rejects(
    ensureDocumentQueuedIngestionJob({
      client,
      documentId: "doc-1",
    }),
    /Required ingestion RPC ensure_document_queued_ingestion_job is unavailable/,
  );
});
