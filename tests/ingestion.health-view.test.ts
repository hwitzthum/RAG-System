import assert from "node:assert/strict";
import test from "node:test";
import {
  countProcessingDocumentMismatches,
  countReadyDocumentsWithoutChunks,
  summarizeProcessingHeartbeat,
} from "../lib/ingestion/runtime/health-view";

test("countProcessingDocumentMismatches flags processing documents whose latest job is not processing", () => {
  const count = countProcessingDocumentMismatches([
    { raw_document_status: "processing", latest_job_status: "processing", chunk_count: 0 },
    { raw_document_status: "processing", latest_job_status: "queued", chunk_count: 0 },
    { raw_document_status: "ready", latest_job_status: "completed", chunk_count: 3 },
    { raw_document_status: "processing", latest_job_status: null, chunk_count: 0 },
  ]);

  assert.equal(count, 2);
});

test("countReadyDocumentsWithoutChunks flags raw ready documents with zero chunks", () => {
  const count = countReadyDocumentsWithoutChunks([
    { raw_document_status: "ready", latest_job_status: "completed", chunk_count: 0 },
    { raw_document_status: "ready", latest_job_status: "completed", chunk_count: 4 },
    { raw_document_status: "processing", latest_job_status: "processing", chunk_count: 0 },
  ]);

  assert.equal(count, 1);
});

test("summarizeProcessingHeartbeat distinguishes missing locks, lagging heartbeats, and stale jobs", () => {
  const nowMs = Date.parse("2026-03-13T20:30:00.000Z");
  const summary = summarizeProcessingHeartbeat(
    [
      {
        locked_at: "2026-03-13T20:28:00.000Z",
        locked_by: "worker-1",
        updated_at: "2026-03-13T20:29:00.000Z",
        current_stage: "embedding",
      },
      {
        locked_at: "2026-03-13T20:20:00.000Z",
        locked_by: "worker-2",
        updated_at: "2026-03-13T20:23:00.000Z",
        current_stage: "storing",
      },
      {
        locked_at: "2026-03-13T20:05:00.000Z",
        locked_by: "worker-3",
        updated_at: "2026-03-13T20:05:00.000Z",
        current_stage: "extracting",
      },
      {
        locked_at: null,
        locked_by: null,
        updated_at: "2026-03-13T20:28:00.000Z",
        current_stage: null,
      },
    ],
    {
      nowMs,
      staleProcessingMinutes: 20,
      heartbeatLagMinutes: 5,
    },
  );

  assert.deepEqual(summary, {
    staleProcessingCount: 1,
    processingWithoutLockCount: 1,
    laggingProcessingCount: 1,
    maxHeartbeatLagSeconds: 420,
    stageCounts: {
      embedding: 1,
      storing: 1,
      extracting: 1,
      unknown: 1,
    },
  });
});
