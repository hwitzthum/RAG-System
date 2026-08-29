import assert from "node:assert/strict";
import test from "node:test";
import { extractPages } from "../lib/ingestion/runtime/pdf-extractor";

// A valid single-page PDF with no content stream at all: pdfjs parses it and
// returns one page with no text — the shape of a scanned or image-only file.
const BLANK_PAGE_PDF = new TextEncoder().encode(
  [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj",
    "xref",
    "0 4",
    "0000000000 65535 f ",
    "0000000009 00000 n ",
    "0000000058 00000 n ",
    "0000000115 00000 n ",
    "trailer<</Size 4/Root 1 0 R>>",
    "startxref",
    "178",
    "%%EOF",
  ].join("\n"),
);

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

test("extractPages OCRs pages without a text layer and keeps their page numbers", async () => {
  const seen: number[] = [];
  const pages = await extractPages(
    BLANK_PAGE_PDF,
    {
      transcribePage: async ({ png, pageNumber }) => {
        seen.push(pageNumber);
        // The renderer must hand the transcriber a real PNG.
        assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
        return "Transcribed page text.";
      },
    },
    silentLogger,
  );

  assert.deepEqual(seen, [1]);
  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.pageNumber, 1);
  assert.equal(pages[0]?.method, "ocr");
  assert.equal(pages[0]?.text, "Transcribed page text.");
});

test("extractPages falls through to the byte scrape when OCR finds no text", async () => {
  const pages = await extractPages(
    BLANK_PAGE_PDF,
    { transcribePage: async () => "" },
    silentLogger,
  );

  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.method, "byte_scrape");
  assert.equal(pages[0]?.text, "");
});

test("extractPages leaves textless pages alone when OCR is disabled", async () => {
  const pages = await extractPages(BLANK_PAGE_PDF, null, silentLogger);

  assert.equal(pages[0]?.method, "byte_scrape");
});
