import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAX_PDF_PAGES,
  extractPages,
  PdfPageLimitExceededError,
} from "../lib/ingestion/runtime/pdf-extractor";
import type { RuntimeLogger } from "../lib/ingestion/runtime/types";

const silentLogger: RuntimeLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Builds a structurally valid, minimal PDF with `pageCount` blank pages (no
 * content stream on any of them — the shape of a scanned or image-only
 * file). Byte offsets in the xref table are computed exactly, so pdfjs-dist
 * parses this the same way it would a real multi-page document, without
 * falling back to the byte-scrape recovery path.
 *
 * This is the shape of the real attack this guard defends against: a PDF
 * that is tiny on disk but carries an enormous page count, where every page
 * would otherwise be routed to a paid OCR call.
 */
function buildBlankPagePdf(pageCount: number): Uint8Array {
  const catalogObj = "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n";
  const kids = Array.from({ length: pageCount }, (_, i) => `${3 + i} 0 R`).join(" ");
  const pagesObj = `2 0 obj<</Type/Pages/Kids[${kids}]/Count ${pageCount}>>endobj\n`;
  const pageObjs = Array.from(
    { length: pageCount },
    (_, i) => `${3 + i} 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\n`,
  );
  const objects = [catalogObj, pagesObj, ...pageObjs];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }

  const totalObjects = objects.length + 1;
  let xref = `xref\n0 ${totalObjects}\n0000000000 65535 f \n`;
  for (let i = 1; i < totalObjects; i += 1) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }

  const xrefStart = body.length;
  body += xref;
  body += `trailer<</Size ${totalObjects}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;

  return new TextEncoder().encode(body);
}

test("extractPages rejects a PDF whose page count exceeds maxPages, before any OCR call", async () => {
  const pdfBytes = buildBlankPagePdf(12);
  let ocrCalls = 0;

  await assert.rejects(
    () =>
      extractPages(
        pdfBytes,
        {
          transcribePage: async () => {
            ocrCalls += 1;
            return "should never run";
          },
        },
        silentLogger,
        10,
      ),
    (error: unknown) => {
      assert.ok(error instanceof PdfPageLimitExceededError);
      assert.equal(error.pageCount, 12);
      assert.equal(error.maxPages, 10);
      return true;
    },
  );

  assert.equal(
    ocrCalls,
    0,
    "a document over the page limit must never reach the per-page OCR fan-out",
  );
});

test("extractPages rejects a many-page, mostly-blank PDF against the default limit without hanging", async () => {
  // Simulates the real attack shape: a PDF well within any byte-size upload
  // cap, but with far more pages than any legitimate document, each of which
  // would otherwise fan out into a billed OCR call.
  const pdfBytes = buildBlankPagePdf(DEFAULT_MAX_PDF_PAGES + 5000);
  let ocrCalls = 0;

  const startedAt = Date.now();
  await assert.rejects(
    () =>
      extractPages(pdfBytes, { transcribePage: async () => { ocrCalls += 1; return ""; } }, silentLogger),
    PdfPageLimitExceededError,
  );
  const elapsedMs = Date.now() - startedAt;

  assert.equal(ocrCalls, 0);
  assert.ok(
    elapsedMs < 10_000,
    `expected the page-count check to reject quickly without iterating pages, took ${elapsedMs}ms`,
  );
});

test("extractPages proceeds normally for a PDF within maxPages", async () => {
  const pdfBytes = buildBlankPagePdf(3);
  const seenPageNumbers: number[] = [];

  const pages = await extractPages(
    pdfBytes,
    {
      transcribePage: async ({ pageNumber }) => {
        seenPageNumbers.push(pageNumber);
        return `Transcribed page ${pageNumber}.`;
      },
    },
    silentLogger,
    10,
  );

  assert.equal(pages.length, 3);
  assert.deepEqual(seenPageNumbers.sort(), [1, 2, 3]);
});
