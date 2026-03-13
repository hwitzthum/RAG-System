import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentWithInitialJob, type UploadCreateClient } from "../lib/ingestion/upload-create";

function createRpcSuccessClient(): UploadCreateClient {
  return {
    async runCreateDocumentWithInitialJobRpc() {
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
            created_at: "2026-03-13T00:00:00.000Z",
          },
        ],
        error: null,
      };
    },
  };
}

test("createDocumentWithInitialJob returns mapped RPC rows", async () => {
  const result = await createDocumentWithInitialJob({
    client: createRpcSuccessClient(),
    storagePath: "uploads/doc-1.pdf",
    checksumSha256: "sha-1",
    title: "Test",
    languageHint: "EN",
  });

  assert.deepEqual(result, {
    documentId: "doc-1",
    ingestionJobId: "job-1",
    documentStatus: "queued",
    ingestionJobStatus: "queued",
    storagePath: "uploads/doc-1.pdf",
    checksumSha256: "sha-1",
  });
});

test("createDocumentWithInitialJob returns null when RPC reports no insert", async () => {
  const client: UploadCreateClient = {
    async runCreateDocumentWithInitialJobRpc() {
      return { data: [], error: null };
    },
  };

  const result = await createDocumentWithInitialJob({
    client,
    storagePath: "uploads/doc-1.pdf",
    checksumSha256: "sha-1",
    title: "Test",
    languageHint: null,
  });

  assert.equal(result, null);
});

test("createDocumentWithInitialJob throws when the RPC is unavailable", async () => {
  const client: UploadCreateClient = {
    async runCreateDocumentWithInitialJobRpc() {
      return {
        data: null,
        error: { message: "Could not find the function public.create_document_with_ingestion_job" },
      };
    },
  };

  await assert.rejects(
    createDocumentWithInitialJob({
      client,
      storagePath: "uploads/doc-fallback.pdf",
      checksumSha256: "sha-fallback",
      title: "Fallback",
      languageHint: "DE",
    }),
    /Required ingestion RPC create_document_with_ingestion_job is unavailable/,
  );
});
