import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIdempotencyKey,
  buildStoragePath,
  normalizeLanguageHint,
} from "../lib/ingestion/upload-helpers";
import { isDuplicateAccessibleToUser, shouldRequeueExistingDocument } from "../lib/ingestion/upload-state";

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

test("isDuplicateAccessibleToUser allows shared (null-owned) documents to dedup for any user", () => {
  assert.equal(isDuplicateAccessibleToUser(null, "user-a"), true);
});

test("isDuplicateAccessibleToUser allows a user to dedup against their own prior upload", () => {
  assert.equal(isDuplicateAccessibleToUser("user-a", "user-a"), true);
});

test("isDuplicateAccessibleToUser rejects dedup across different owning users", () => {
  // A checksum collision with a document privately owned by a different user
  // must never be surfaced as a dedup hit — otherwise an attacker who merely
  // holds a byte-identical copy of another user's file could confirm its
  // existence and learn its documentId/storagePath without ever being
  // granted access to it.
  assert.equal(isDuplicateAccessibleToUser("user-a", "user-b"), false);
});
