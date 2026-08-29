import type { ExtractedPage } from "@/lib/ingestion/runtime/types";

/**
 * Removes running heads, running feet, and folio numbers from extracted pages.
 *
 * A typeset book repeats the author on every verso and the chapter on every
 * recto, each with the page number beside it. Nothing downstream knew that:
 * `isHeading` accepts any short capitalised line, so `DAVID CHARLES` was
 * detected as a top-level heading on all 313 pages of one book and pushed onto
 * the breadcrumb stack, while the folio glued itself to the following
 * paragraph ("2 Introduction events, states and their properties…").
 *
 * The damage was not cosmetic. `sectionTitle` is embedded into the chunk
 * vector, indexed into the keyword tsvector, and passed to the answering model
 * as the `section` attribute of every evidence chunk — so the running head
 * displaced the real outline in all three. 442 of that book's 461 chunks
 * carried it, the whole 313 pages collapsed to 30 distinct section titles, and
 * the top hit for a question about Aristotle on soul and body was the
 * copyright page, whose running head repeats the book's title verbatim.
 *
 * Detection is positional and statistical rather than pattern-based: a line
 * near a page edge that recurs, modulo its folio number, on many pages is
 * furniture whatever it says. That holds for languages and layouts no regex
 * would anticipate, and it leaves single-occurrence lines — real headings —
 * untouched.
 */

/** How many lines at each edge of a page can be furniture. */
const EDGE_BAND_LINES = 3;
/**
 * A folio offset needs this much support before it is trusted to strip lines.
 * Printed page 1 is never physical page 1 — front matter shifts it — but the
 * shift is constant, so the offset that most pages agree on is the real one.
 */
const MIN_FOLIO_OFFSET_PAGES = 4;
const MIN_FOLIO_OFFSET_RATIO = 0.1;
/**
 * Furniture must recur on at least this many pages *and* this share of them.
 * The floor stops a 20-page document from calling a twice-seen line furniture;
 * the ratio stops a long document from accumulating false positives just
 * because it has many pages. A chapter-scoped running head only covers its own
 * chapter, so the ratio has to stay well below half.
 */
const MIN_REPEAT_PAGES = 4;
const MIN_REPEAT_RATIO = 0.02;
/** Running heads are short. A long recurring line is content — a legal boilerplate clause, say. */
const MAX_FURNITURE_CHARS = 80;
/** Below this, "recurs across pages" carries no signal. */
const MIN_PAGES_FOR_DETECTION = 5;

/**
 * Collapses the parts of a running head that vary from page to page, so the
 * verso heads `2 Introduction` and `4 Introduction` compare equal — and so a
 * bare folio compares equal to every other bare folio.
 *
 * Roman numerals need two characters or more: front matter is numbered `viii`,
 * but a lone `I` is the English pronoun and a legitimate line start.
 */
export function normalizePageFurniture(line: string): string {
  return line
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\d+\b/g, "#")
    .replace(/\b[ivxlcdm]{2,}\b/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Lines near a page edge, where furniture lives.
 *
 * The band has to shrink on a sparse page. A three-line page is entirely
 * "edge" under a fixed band of three, so body text that happens to recur —
 * a repeated caption, a boilerplate line — looks exactly like a running head
 * and was stripped as one. Keeping the band strictly smaller than half the
 * page means there is always a middle that is safe from the repetition rule.
 */
function edgeBand(total: number): number {
  return Math.max(1, Math.min(EDGE_BAND_LINES, Math.floor((total - 1) / 2)));
}

function isEdgeLine(index: number, total: number): boolean {
  const band = edgeBand(total);
  return index < band || index >= total - band;
}

function isFurnitureCandidate(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_FURNITURE_CHARS;
}

/**
 * Physical-page-to-printed-folio offset that most pages agree on, or null when
 * too few do.
 *
 * Repetition alone is not enough on a real book. A verso head repeats the
 * chapter across its whole chapter, but a recto head often carries the
 * *section* title, which turns over every few pages — too rarely to clear any
 * repetition threshold that is also safe on short documents. The folio is the
 * signal that does not vary: an edge line whose number is exactly this
 * document's offset from the physical page is a running head no matter what
 * words sit beside it.
 */
function detectFolioOffset(
  pageLines: string[][],
  pages: ExtractedPage[],
): number | null {
  const offsetPages = new Map<number, Set<number>>();

  pageLines.forEach((lines, pageIndex) => {
    const pageNumber = pages[pageIndex]!.pageNumber;
    lines.forEach((line, lineIndex) => {
      if (!isEdgeLine(lineIndex, lines.length) || !isFurnitureCandidate(line)) {
        return;
      }
      for (const match of line.matchAll(/\b\d{1,4}\b/g)) {
        const folio = Number.parseInt(match[0]!, 10);
        // A folio runs ahead of no physical page and lags by only the front
        // matter, so negative and implausibly large offsets are coincidences.
        const offset = pageNumber - folio;
        if (offset < 0 || offset > pages.length) {
          continue;
        }
        const seenOn = offsetPages.get(offset);
        if (seenOn) {
          seenOn.add(pageIndex);
          continue;
        }
        offsetPages.set(offset, new Set([pageIndex]));
      }
    });
  });

  const required = Math.max(
    MIN_FOLIO_OFFSET_PAGES,
    Math.ceil(pages.length * MIN_FOLIO_OFFSET_RATIO),
  );

  let bestOffset: number | null = null;
  let bestCount = 0;
  for (const [offset, seenOn] of offsetPages.entries()) {
    if (seenOn.size > bestCount) {
      bestCount = seenOn.size;
      bestOffset = offset;
    }
  }

  return bestCount >= required ? bestOffset : null;
}

function hasFolio(line: string, pageNumber: number, offset: number): boolean {
  const expected = pageNumber - offset;
  for (const match of line.matchAll(/\b\d{1,4}\b/g)) {
    if (Number.parseInt(match[0]!, 10) === expected) {
      return true;
    }
  }
  return false;
}

/**
 * The running head with its folio removed — `Taste and Smell 131` becomes
 * `Taste and Smell` — or null when nothing usable is left.
 */
function runningHeadText(line: string, pageNumber: number, offset: number | null): string | null {
  let text = line.trim();
  if (offset !== null) {
    text = text.replace(
      new RegExp(`\\b${pageNumber - offset}\\b`, "g"),
      " ",
    );
  }
  text = text
    .replace(/\s+/g, " ")
    // Folios are set off by rules and dots in many templates.
    .replace(/^[\s\-–—.·|]+|[\s\-–—.·|]+$/g, "")
    .trim();

  // Two letters is the shortest thing that could name a section; anything less
  // is leftover punctuation.
  return /\p{L}{2,}/u.test(text) ? text : null;
}

export type PageFurnitureReport = {
  /** Normalized forms judged to be furniture, most frequent first. */
  patterns: Array<{ pattern: string; pages: number }>;
  /** Physical-page-to-printed-folio offset, when one was established. */
  folioOffset: number | null;
  linesRemoved: number;
};

/**
 * Strips detected furniture from every page, returning the cleaned pages and a
 * report worth logging — over-stripping would silently delete content, so the
 * decision has to be visible in the ingestion trace.
 */
export function stripPageFurniture(pages: ExtractedPage[]): {
  pages: ExtractedPage[];
  /**
   * Running head per page number, folio removed.
   *
   * Deleting these and stopping there would throw away the most dependable
   * outline signal a typeset book has. Typographic heading detection cannot
   * tell a chapter from a title page — a book sets its author in caps on page
   * 3, which `headingDepth` reads as depth 1, and since real chapter titles
   * are title case they can only ever nest *under* it. That one line then led
   * the breadcrumb for all 313 pages of the book measured here. The running
   * head states, on the page itself, which chapter the page belongs to.
   */
  runningHeads: Map<number, string>;
  report: PageFurnitureReport;
} {
  const emptyReport: PageFurnitureReport = {
    patterns: [],
    folioOffset: null,
    linesRemoved: 0,
  };
  if (pages.length < MIN_PAGES_FOR_DETECTION) {
    return { pages, runningHeads: new Map(), report: emptyReport };
  }

  const pageLines = pages.map((page) => page.text.split(/\r?\n/));

  // A page that repeats a head on several of its own lines must not count more
  // than once, or a single page could clear the threshold by itself.
  const pagesByPattern = new Map<string, Set<number>>();
  pageLines.forEach((lines, pageIndex) => {
    lines.forEach((line, lineIndex) => {
      if (!isEdgeLine(lineIndex, lines.length) || !isFurnitureCandidate(line)) {
        return;
      }
      const normalized = normalizePageFurniture(line);
      if (!normalized) {
        return;
      }
      const seenOn = pagesByPattern.get(normalized);
      if (seenOn) {
        seenOn.add(pageIndex);
        return;
      }
      pagesByPattern.set(normalized, new Set([pageIndex]));
    });
  });

  const threshold = Math.max(
    MIN_REPEAT_PAGES,
    Math.ceil(pages.length * MIN_REPEAT_RATIO),
  );
  const furniture = new Map<string, number>();
  for (const [pattern, seenOn] of pagesByPattern.entries()) {
    if (seenOn.size >= threshold) {
      furniture.set(pattern, seenOn.size);
    }
  }

  const folioOffset = detectFolioOffset(pageLines, pages);

  if (furniture.size === 0 && folioOffset === null) {
    return { pages, runningHeads: new Map(), report: emptyReport };
  }

  let linesRemoved = 0;
  const runningHeads = new Map<number, string>();
  const cleaned = pages.map((page, pageIndex) => {
    const lines = pageLines[pageIndex]!;
    const kept = lines.filter((line, lineIndex) => {
      if (!isEdgeLine(lineIndex, lines.length) || !isFurnitureCandidate(line)) {
        return true;
      }
      const isRepeated = furniture.has(normalizePageFurniture(line));
      const isFolioLine =
        folioOffset !== null &&
        hasFolio(line, page.pageNumber, folioOffset);
      if (!isRepeated && !isFolioLine) {
        return true;
      }
      linesRemoved += 1;
      // Only the head, never the foot: a running foot is usually the folio
      // alone and names nothing.
      if (
        lineIndex < edgeBand(lines.length) &&
        !runningHeads.has(page.pageNumber)
      ) {
        const head = runningHeadText(line, page.pageNumber, folioOffset);
        if (head) {
          runningHeads.set(page.pageNumber, head);
        }
      }
      return false;
    });

    if (kept.length === lines.length) {
      return page;
    }
    return { ...page, text: kept.join("\n").trim() };
  });

  return {
    pages: cleaned,
    runningHeads,
    report: {
      patterns: [...furniture.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 10)
        .map(([pattern, count]) => ({ pattern, pages: count })),
      folioOffset,
      linesRemoved,
    },
  };
}
