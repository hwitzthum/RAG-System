import assert from "node:assert/strict";
import test from "node:test";
import { queueBatchUploadEntry, queueSingleUpload } from "../lib/ingestion/upload-queue";

type PersistedResult = {
  documentId: string;
  ingestionJobId: string;
  documentStatus: "queued" | "processing" | "ready" | "failed";
  ingestionJobStatus: "queued" | "processing" | "completed" | "failed" | "dead_letter";
  status: "queued" | "processing" | "completed" | "failed" | "dead_letter";
  deduplicated: boolean;
  storagePath: string;
  checksumSha256: string;
};

const authUser = { id: "user-1", role: "admin" as const, email: "admin@example.com" };

function buildPdfFile(name: string): File {
  return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])], name, {
    type: "application/pdf",
  });
}

test("queueSingleUpload persists the document and returns the queued response payload", async () => {
  const persistCalls: Array<{ fileName: string; title: string | null; languageHint: string | null }> = [];
  const auditEvents: Array<Record<string, unknown>> = [];
  const persisted: PersistedResult = {
    documentId: "doc-single",
    ingestionJobId: "job-single",
    documentStatus: "queued",
    ingestionJobStatus: "queued",
    status: "queued",
    deduplicated: false,
    storagePath: "uploads/doc-single.pdf",
    checksumSha256: "sha-single",
  };

  const result = await queueSingleUpload({
    file: buildPdfFile("single.pdf"),
    title: "Single Upload",
    languageHint: "DE",
    user: authUser,
    ipAddress: "127.0.0.1",
    dependencies: {
      persistUploadAndQueueJob: async (input) => {
        persistCalls.push({
          fileName: input.file.name,
          title: input.title,
          languageHint: input.languageHint,
        });
        return persisted;
      },
      logAuditEvent: (input) => {
        auditEvents.push(input as unknown as Record<string, unknown>);
      },
    },
  });

  assert.deepEqual(persistCalls, [
    {
      fileName: "single.pdf",
      title: "Single Upload",
      languageHint: "DE",
    },
  ]);
  assert.equal(result.statusCode, 201);
  assert.equal(result.body.documentId, "doc-single");
  assert.equal(result.body.ingestionJobId, "job-single");
  assert.equal(result.body.status, "queued");
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0]?.action, "upload.create");
});

test("queueBatchUploadEntry persists a valid PDF and marks it accepted", async () => {
  const persistCalls: Array<{ fileName: string; title: string | null; languageHint: string | null }> = [];
  const auditEvents: Array<Record<string, unknown>> = [];
  const persisted: PersistedResult = {
    documentId: "doc-batch",
    ingestionJobId: "job-batch",
    documentStatus: "queued",
    ingestionJobStatus: "queued",
    status: "queued",
    deduplicated: false,
    storagePath: "uploads/doc-batch.pdf",
    checksumSha256: "sha-batch",
  };

  const result = await queueBatchUploadEntry({
    file: buildPdfFile("batch.pdf"),
    title: "batch.pdf",
    languageHint: null,
    user: authUser,
    ipAddress: "127.0.0.1",
    dependencies: {
      persistUploadAndQueueJob: async (input) => {
        persistCalls.push({
          fileName: input.file.name,
          title: input.title,
          languageHint: input.languageHint,
        });
        return persisted;
      },
      logAuditEvent: (input) => {
        auditEvents.push(input as unknown as Record<string, unknown>);
      },
    },
  });

  assert.deepEqual(persistCalls, [
    {
      fileName: "batch.pdf",
      title: "batch.pdf",
      languageHint: null,
    },
  ]);
  assert.deepEqual(result, {
    fileName: "batch.pdf",
    documentId: "doc-batch",
    status: "accepted",
  });
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0]?.action, "upload.batch.file");
});
