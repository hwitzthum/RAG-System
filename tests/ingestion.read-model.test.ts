import assert from "node:assert/strict";
import test from "node:test";
import { deriveEffectiveDocumentStatus } from "../lib/ingestion/runtime/read-model";

test("deriveEffectiveDocumentStatus prefers processing latest job state", () => {
  assert.equal(
    deriveEffectiveDocumentStatus({
      documentStatus: "queued",
      latestJobStatus: "processing",
      chunkCount: null,
    }),
    "processing",
  );
});

test("deriveEffectiveDocumentStatus maps transient failed job state back to queued", () => {
  assert.equal(
    deriveEffectiveDocumentStatus({
      documentStatus: "processing",
      latestJobStatus: "failed",
      chunkCount: null,
    }),
    "queued",
  );
});

test("deriveEffectiveDocumentStatus maps dead-letter jobs to failed", () => {
  assert.equal(
    deriveEffectiveDocumentStatus({
      documentStatus: "processing",
      latestJobStatus: "dead_letter",
      chunkCount: null,
    }),
    "failed",
  );
});

test("deriveEffectiveDocumentStatus marks completed jobs with chunks as ready", () => {
  assert.equal(
    deriveEffectiveDocumentStatus({
      documentStatus: "processing",
      latestJobStatus: "completed",
      chunkCount: 4,
    }),
    "ready",
  );
});

test("deriveEffectiveDocumentStatus marks completed jobs without chunks as failed", () => {
  assert.equal(
    deriveEffectiveDocumentStatus({
      documentStatus: "ready",
      latestJobStatus: "completed",
      chunkCount: 0,
    }),
    "failed",
  );
});

test("deriveEffectiveDocumentStatus preserves document status when no job exists", () => {
  assert.equal(
    deriveEffectiveDocumentStatus({
      documentStatus: "ready",
      latestJobStatus: null,
      chunkCount: null,
    }),
    "ready",
  );
});
