import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIdempotencyKey,
  buildStoragePath,
  normalizeLanguageHint,
} from "../lib/ingestion/upload-helpers";
import { shouldRequeueExistingDocument } from "../lib/ingestion/upload-state";

test("buildIdempotencyKey includes checksum and version", () => {
  const key = buildIdempotencyKey("abc123", 7);
  assert.equal(key, "abc123:v7");
});

test("buildStoragePath sanitizes file name and preserves pdf suffix", () => {
  const path = buildStoragePath("deadbeef", "Brochure 2026 FINAL!.pdf");
  assert.equal(path, "uploads/deadbeef-brochure-2026-final.pdf");
});

test("normalizeLanguageHint accepts supported values and rejects invalid ones", () => {
  assert.equal(normalizeLanguageHint("de"), "DE");
  assert.equal(normalizeLanguageHint("ES"), "ES");
  assert.equal(normalizeLanguageHint("pt"), null);
  assert.equal(normalizeLanguageHint(null), null);
});

test("shouldRequeueExistingDocument only requeues terminal failed states", () => {
  assert.equal(shouldRequeueExistingDocument("failed", null), true);
  assert.equal(shouldRequeueExistingDocument("queued", "dead_letter"), true);
  assert.equal(shouldRequeueExistingDocument("queued", "failed"), false);
  assert.equal(shouldRequeueExistingDocument("ready", "completed"), false);
});
