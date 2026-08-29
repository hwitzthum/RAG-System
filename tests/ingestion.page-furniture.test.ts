import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePageFurniture,
  stripPageFurniture,
} from "../lib/ingestion/runtime/page-furniture";
import { splitPagesIntoSections } from "../lib/ingestion/runtime/chunking";
import type { ExtractedPage } from "../lib/ingestion/runtime/types";

/** Digit-free per-page token, so body prose differs page to page as real prose does. */
function nonce(value: number): string {
  let out = "";
  let remaining = value + 1;
  while (remaining > 0) {
    out += String.fromCharCode(97 + ((remaining - 1) % 26));
    remaining = Math.floor((remaining - 1) / 26);
  }
  return out;
}

/** A book: verso carries the author, recto the chapter, both beside a folio. */
function buildBook(pageCount: number, folioOffset = 4): ExtractedPage[] {
  return Array.from({ length: pageCount }, (_, index) => {
    // Start past the front matter so every folio is positive.
    const pageNumber = index + folioOffset + 1;
    const folio = pageNumber - folioOffset;
    const head =
      pageNumber % 2 === 0
        ? `${folio} DAVID CHARLES`
        : `Taste and Smell ${folio}`;
    return {
      pageNumber,
      text: [
        head,
        // Body free of digits, so only the head can carry a folio.
        ...Array.from(
          { length: 8 },
          (_unused, line) =>
            `Prose ${nonce(pageNumber)} ${nonce(line)} carrying this page's argument forward.`,
        ),
      ].join("\n"),
    };
  });
}

test("normalizePageFurniture collapses folios and roman numerals", () => {
  assert.equal(normalizePageFurniture("12 Introduction"), "# introduction");
  assert.equal(normalizePageFurniture("Introduction 3"), "introduction #");
  assert.equal(normalizePageFurniture("viii Preface"), "# preface");
  // A lone "I" is the pronoun, not a numeral.
  assert.equal(normalizePageFurniture("I saw it"), "i saw it");
});

test("stripPageFurniture removes running heads and recovers the folio offset", () => {
  const { pages, runningHeads, report } = stripPageFurniture(buildBook(40));

  assert.equal(report.folioOffset, 4);
  assert.equal(report.linesRemoved, 40);
  for (const page of pages) {
    assert.equal(page.text.includes("DAVID CHARLES"), false);
    assert.equal(page.text.includes("Taste and Smell"), false);
    assert.equal(page.text.startsWith("Prose "), true);
  }
  // The head is kept as the page's outline label, folio removed.
  assert.equal(runningHeads.get(5), "Taste and Smell");
  assert.equal(runningHeads.get(6), "DAVID CHARLES");
});

test("stripPageFurniture leaves short documents untouched", () => {
  const pages: ExtractedPage[] = [
    { pageNumber: 1, text: "Heading\nBody one." },
    { pageNumber: 2, text: "Heading\nBody two." },
  ];
  const result = stripPageFurniture(pages);
  assert.equal(result.report.linesRemoved, 0);
  assert.deepEqual(result.pages, pages);
});

test("stripPageFurniture keeps content that merely recurs mid-page", () => {
  // The repeated line sits away from both edges, so it is body text.
  const pages: ExtractedPage[] = Array.from({ length: 12 }, (_, index) => ({
    pageNumber: index + 1,
    text: [
      `Head ${index + 1}`,
      "filler a",
      "filler b",
      "THE REPEATED CLAUSE",
      "filler c",
      "filler d",
      "tail",
    ].join("\n"),
  }));
  const { pages: cleaned } = stripPageFurniture(pages);
  for (const page of cleaned) {
    assert.equal(page.text.includes("THE REPEATED CLAUSE"), true);
  }
});

test("a running head replaces a stale front-matter heading in the breadcrumb", () => {
  // Regression: an all-caps title-page line is depth 1, and real chapter
  // titles are title case (depth 2), so the title page led the breadcrumb of
  // every page in the document — 442 of one book's 461 chunks carried it.
  const pages: ExtractedPage[] = [
    { pageNumber: 1, text: "DAVID CHARLES\nTitle page matter." },
    ...Array.from({ length: 10 }, (_, index) => ({
      pageNumber: index + 2,
      text: [
        `Taste and Smell ${index + 2}`,
        `Body content unique to page ${"y".repeat(index)} of the chapter.`,
        "Further prose so the page has a middle the edge band cannot reach.",
        "And a third body line of ordinary chapter prose.",
      ].join("\n"),
    })),
  ];

  const { pages: cleaned, runningHeads } = stripPageFurniture(pages);
  const sections = splitPagesIntoSections(cleaned, runningHeads);

  const bodySections = sections.filter((section) => section.pageNumber > 1);
  assert.equal(bodySections.length > 0, true);
  for (const section of bodySections) {
    assert.equal(section.sectionTitle.includes("DAVID CHARLES"), false);
    assert.equal(section.sectionTitle, "Taste and Smell");
  }
});

test("splitPagesIntoSections bounds an unbounded heading path", () => {
  const longHeading = "A".repeat(150);
  const pages: ExtractedPage[] = [
    {
      pageNumber: 1,
      text: [
        longHeading,
        "Body under the first heading.",
        `${"B".repeat(150)}`,
        "Body under the second heading.",
      ].join("\n"),
    },
  ];
  for (const section of splitPagesIntoSections(pages)) {
    assert.equal(section.sectionTitle.length <= 182, true);
  }
});
