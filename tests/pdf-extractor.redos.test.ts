import assert from "node:assert/strict";
import test from "node:test";
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
 *    extractPages falls back to the manual byte-scanning extractor
 *    (lib/ingestion/runtime/pdf-extractor.ts's extractTextFromPdfOperators /
 *    extractTextOperatorsFromContent).
 *  - embeds an uncompressed "BT ... ET" text-object scope containing an
 *    unterminated `[` array operand made of nothing but backslashes. The
 *    fallback scanner's operatorRegex previously matched the array body with
 *    `(?:\\.|[^\]])*?` — since `[^\]]` does not exclude `\`, a run of N
 *    backslashes with no closing `]` can be partitioned into escape pairs or
 *    single characters in exponentially many ways, so the regex engine's
 *    backtracking search blew up long before it could conclude "no match".
 */
function buildBackslashBombPdfBytes(backslashCount: number): Buffer {
  const body = `BT [${"\\".repeat(backslashCount)}`;
  return Buffer.from(body, "latin1");
}

test("extractPages does not hang on a PDF fallback-scan ReDoS payload (unterminated backslash-run array operand)", async () => {
  // 200 backslashes is far below anything a real content stream would ever
  // contain, but enough to take an unbounded number of years with the
  // original ambiguous regex (the same pattern took over 1 second at just 42
  // backslashes in isolation — growth is roughly exponential per character).
  const bombBytes = buildBackslashBombPdfBytes(200);

  const startedAt = Date.now();
  const pages = await extractPages(bombBytes, null, silentLogger);
  const elapsedMs = Date.now() - startedAt;

  assert.ok(Array.isArray(pages), "extractPages should resolve with a page array, not hang");
  assert.ok(
    elapsedMs < 5_000,
    `extractPages took ${elapsedMs}ms — expected the fallback scanner to stay linear instead of catastrophically backtracking`,
  );
});

test("extractPages still extracts text from legitimate TJ array operators after the regex fix", async () => {
  // A minimal, well-formed content-stream fragment using the array-operator
  // (TJ) form, including an escaped-parenthesis literal string operand — the
  // fix must not change matching behaviour for real PDF content streams.
  const body = 'BT [(Hello) -20 (World) (A\\(B\\)C)] TJ ET';
  const pdfBytes = Buffer.from(body, "latin1");

  const pages = await extractPages(pdfBytes, null, silentLogger);

  assert.ok(pages.length > 0, "extractPages should return at least one page");
  const text = pages.map((page) => page.text).join(" ");
  assert.match(text, /Hello/);
  assert.match(text, /World/);
});
