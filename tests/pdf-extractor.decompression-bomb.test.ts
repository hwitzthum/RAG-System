import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { extractPages } from "../lib/ingestion/runtime/pdf-extractor";
import type { RuntimeLogger } from "../lib/ingestion/runtime/types";

const silentLogger: RuntimeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Builds a byte buffer that:
 *  - is NOT a structurally valid PDF, so pdfjs-dist fails/returns empty and
 *    extractPages falls back to the manual "stream ... endstream" scanner
 *    (lib/ingestion/runtime/pdf-extractor.ts's extractTextFromPdfOperators).
 *  - contains one object whose dictionary declares /Filter /FlateDecode and
 *    whose stream body is a small deflate payload that decompresses to far
 *    more than MAX_INFLATED_STREAM_BYTES (25 MB) — a classic zlib
 *    "decompression bomb": trivially compressible input (repeated zero
 *    bytes) achieves a huge compression ratio.
 */
function buildDecompressionBombPdfBytes(decompressedSize: number): Buffer {
  const zeros = Buffer.alloc(decompressedSize, 0);
  const compressed = deflateSync(zeros);

  const header = Buffer.from("1 0 obj\n<< /Length 999 /Filter /FlateDecode >>\nstream\n", "latin1");
  const footer = Buffer.from("\nendstream\nendobj\n", "latin1");

  return Buffer.concat([header, compressed, footer]);
}

test("extractPages does not exhaust memory when a malicious PDF embeds a zlib decompression bomb", async () => {
  // 1 GB of zeros deflates down to ~1 MB — comfortably clears the
  // extractor's 25 MB maxOutputLength guard by 40x, so this reproduces the
  // unbounded-inflate bug if the guard is ever removed/regressed. (A real
  // attacker would use a far more aggressive ratio to reach multi-GB output
  // from a KB-sized stream; 1 GB is enough to make the difference between
  // "capped" and "uncapped" behavior clearly observable in test timing
  // without making the suite slow.)
  const bombBytes = buildDecompressionBombPdfBytes(1024 * 1024 * 1024);

  const startedAt = Date.now();
  const pages = await extractPages(bombBytes, false, silentLogger);
  const elapsedMs = Date.now() - startedAt;

  // The call must resolve (not throw, not hang) and stay fast. Before the
  // fix, inflateSync would materialize the full 1 GB output (unboundedly
  // more for a more aggressive bomb ratio), which alone measured ~37s of
  // decompression work in this environment — risking worker OOM well before
  // that on a larger/more realistic bomb. The capped decompression aborts as
  // soon as the 25 MB limit is hit, so wall-clock time stays small
  // regardless of how large the bomb's true decompressed size is.
  assert.ok(Array.isArray(pages), "extractPages should resolve with a page array, not throw");
  assert.ok(elapsedMs < 10_000, `extractPages took ${elapsedMs}ms — expected it to bail out quickly instead of inflating the bomb`);
});
