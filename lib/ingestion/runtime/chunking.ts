import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";
import type {
  ChunkCandidate,
  ExtractedPage,
  Section,
} from "@/lib/ingestion/runtime/types";
import type { SupportedLanguage } from "@/lib/supabase/database.types";

// Match headings in ALL CAPS or Title Case (with optional leading numbering like "1.2 Section Name").
// The leading lookahead demands at least one letter: without it a purely
// numeric all-caps line — a table header row such as "2024 2025 2026" — was
// consumed as a section title and dropped from the chunk body entirely.
const HEADING_UPPERCASE =
  /^(?=[^A-Z\u00C4\u00D6\u00DC]*[A-Z\u00C4\u00D6\u00DC])(?:\d+(?:\.\d+)*\s+)?[A-Z\u00C4\u00D6\u00DC0-9][A-Z\u00C4\u00D6\u00DC0-9\s:/-]{3,}$/;
const HEADING_TITLECASE =
  /^(?:\d+(?:\.\d+)*\s+)?[A-Z\u00C0-\u00DC][a-z\u00E0-\u00FF]+(?:\s+(?:[A-Z\u00C0-\u00DC][a-z\u00E0-\u00FF]+|and|or|of|the|for|in|on|to|with|&|\/|-)){1,10}$/;
const RELAXED_MIN_CHARS = 20;

// A Markdown pipe row emitted by the layout-aware page assembler. Tables have
// to survive sectioning, paragraph splitting and chunk packing intact — the
// point of reconstructing them is that a number stays attached to its row and
// column label, and every one of those stages would otherwise flatten them.
const TABLE_ROW_PATTERN = /^\|.*\|$/;

export function isTableRow(line: string): boolean {
  return TABLE_ROW_PATTERN.test(line.trim());
}

function isTableSeparatorRow(line: string): boolean {
  return /^\|(?:\s*-{3,}\s*\|)+$/.test(line.trim());
}

function isHeading(line: string): boolean {
  const candidate = line.trim();
  if (!candidate) {
    return false;
  }
  if (candidate.length > 120) {
    return false;
  }
  // A table row is content, never a section title.
  if (isTableRow(candidate)) {
    return false;
  }
  return HEADING_UPPERCASE.test(candidate) || HEADING_TITLECASE.test(candidate);
}

/**
 * Depth of a heading in the document outline.
 *
 * An explicit numbering prefix is authoritative — `5.4 Mutationen` is depth 2.
 * Without one, an all-caps line is treated as a top-level heading and a
 * title-case line as its child, which is how these documents are typeset.
 */
function headingDepth(line: string): number {
  const numbered = /^(\d+(?:\.\d+)*)\s+/.exec(line);
  if (numbered) {
    return numbered[1]!.split(".").length;
  }
  return HEADING_UPPERCASE.test(line) ? 1 : 2;
}

/**
 * Splits a whole document into sections, carrying the heading path across page
 * boundaries.
 *
 * Sectioning used to run strictly per page, so a heading on page 3 did not
 * reach its continuation on page 4 — which fell back to the title `Page 4`.
 * The breadcrumb (`5. Meldung veränderter Verhältnisse / 5.4 Mutationen`) gives
 * every chunk its ancestry, and item 2.1 puts that string into the embedded
 * vector, where the heading has never appeared.
 */
export function splitPagesIntoSections(pages: ExtractedPage[]): Section[] {
  const sections: Section[] = [];
  // Heading path by depth, persisting across pages.
  let stack: string[] = [];

  for (const page of pages) {
    if (!page.text.trim()) {
      continue;
    }

    const lines = page.text.split(/\r?\n/).map((line) => line.trim());
    const breadcrumb = () =>
      stack.length > 0 ? stack.join(" / ") : `Page ${page.pageNumber}`;

    let currentTitle = breadcrumb();
    let currentContent: string[] = [];
    let previousLineWasBlank = false;
    let emitted = false;

    const flush = () => {
      if (currentContent.length === 0) {
        return;
      }
      sections.push({
        pageNumber: page.pageNumber,
        sectionTitle: currentTitle,
        text: currentContent
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim(),
      });
      currentContent = [];
      emitted = true;
    };

    for (const line of lines) {
      if (!line) {
        if (currentContent.length > 0 && !previousLineWasBlank) {
          currentContent.push("");
        }
        previousLineWasBlank = true;
        continue;
      }

      if (isHeading(line)) {
        flush();
        const depth = headingDepth(line);
        // The heading itself is kept verbatim — no lowercase/title-case
        // round-trip, which mangled acronyms and German compounds into
        // `Mandat ZüRich` and truncated `Capacity Building` to `Pacity
        // Building` in the evaluation set's own labels.
        stack = [...stack.slice(0, depth - 1), line];
        currentTitle = breadcrumb();
        // The heading also leads the section body, so the words a user is
        // most likely to search with reach the embedded text and the tsvector
        // rather than only `section_title`.
        currentContent.push(line);
        previousLineWasBlank = false;
        continue;
      }

      currentContent.push(line);
      previousLineWasBlank = false;
    }

    flush();

    if (!emitted) {
      sections.push({
        pageNumber: page.pageNumber,
        sectionTitle: breadcrumb(),
        text: page.text.trim(),
      });
    }
  }

  return sections;
}

/** Single-page form, for callers and fixtures that have one page in hand. */
export function splitIntoSections(page: ExtractedPage): Section[] {
  return splitPagesIntoSections([page]);
}

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((part) => part.length > 0);
}

function decodeTokens(
  tokens: string[],
  tokenStart: number,
  tokenEnd: number,
): string {
  return tokens.slice(tokenStart, tokenEnd).join(" ");
}

// cl100k_base matches text-embedding-3-large, the model the budgets exist
// for. Lazy: the ranks table is ~1.6 MB and only the ingestion worker pays it.
let bpeEncoder: Tiktoken | null = null;

function getBpeEncoder(): Tiktoken {
  if (!bpeEncoder) {
    bpeEncoder = new Tiktoken(cl100k_base);
  }
  return bpeEncoder;
}

// The packing loop re-counts the same paragraphs (overlap carry-over,
// merge probes), so counts are memoized. Bounded to keep a long-lived worker
// from accumulating unbounded strings.
const TOKEN_COUNT_CACHE_LIMIT = 20_000;
const tokenCountCache = new Map<string, number>();

/**
 * True BPE token count. Chunk budgets (`WORKER_CHUNK_TARGET_TOKENS` etc.) are
 * measured in the embedding model's own tokens — the previous
 * whitespace-word count undercounted by ~30%, so a "700 token" chunk was
 * really ~900-1000 model tokens.
 */
export function countTokens(text: string): number {
  const cached = tokenCountCache.get(text);
  if (cached !== undefined) {
    return cached;
  }

  const count = getBpeEncoder().encode(text).length;
  if (tokenCountCache.size >= TOKEN_COUNT_CACHE_LIMIT) {
    tokenCountCache.clear();
  }
  tokenCountCache.set(text, count);
  return count;
}

const SENTENCE_END_PATTERN = /[.!?]$/;
const SCAN_RADIUS = 50;

function findSentenceBoundary(
  tokens: string[],
  nominalEnd: number,
  totalTokens: number,
): number {
  if (nominalEnd >= totalTokens) return totalTokens;
  const searchStart = Math.max(1, nominalEnd - SCAN_RADIUS);
  const searchEnd = Math.min(totalTokens, nominalEnd + SCAN_RADIUS);
  let bestPosition = nominalEnd;
  let bestDistance = Infinity;
  for (let i = searchStart; i < searchEnd; i++) {
    if (tokens[i - 1] && SENTENCE_END_PATTERN.test(tokens[i - 1])) {
      const distance = Math.abs(i - nominalEnd);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestPosition = i;
      }
    }
  }
  return bestPosition;
}

const BULLET_OR_LIST_PATTERN = /^(?:[-*•]\s+|\d+(?:[.)]\s+))/;

function splitIntoParagraphs(text: string): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const paragraphs: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    paragraphs.push(current.join(" ").replace(/\s+/g, " ").trim());
    current = [];
  };

  // A run of pipe rows is one paragraph, kept verbatim: collapsing its
  // newlines would destroy exactly the row structure the assembler recovered.
  let tableRows: string[] = [];
  const flushTable = () => {
    if (tableRows.length === 0) {
      return;
    }
    paragraphs.push(tableRows.join("\n"));
    tableRows = [];
  };

  for (const line of lines) {
    if (isTableRow(line)) {
      flush();
      tableRows.push(line);
      continue;
    }
    flushTable();

    if (!line) {
      flush();
      continue;
    }

    if (BULLET_OR_LIST_PATTERN.test(line)) {
      flush();
      paragraphs.push(line.replace(/\s+/g, " ").trim());
      continue;
    }

    current.push(line);
  }

  flush();
  flushTable();
  return paragraphs.filter((paragraph) => paragraph.length > 0);
}

function mergeSectionTitles(titles: string[]): string {
  const deduped = titles.filter(
    (title, index) => titles.indexOf(title) === index,
  );
  return deduped.join(" / ");
}

function mergeAdjacentSections(
  sections: Section[],
  targetTokens: number,
  minChars: number,
): Section[] {
  if (sections.length <= 1) {
    return sections;
  }

  const merged: Section[] = [];
  let current = sections[0];

  if (!current) {
    return merged;
  }

  const minSectionChars = Math.max(RELAXED_MIN_CHARS, minChars);

  for (let index = 1; index < sections.length; index += 1) {
    const next = sections[index]!;
    const combinedText = `${current.text}\n\n${next.text}`.trim();
    const combinedTokens = countTokens(combinedText);
    const currentTooSmall = current.text.trim().length < minSectionChars;
    const nextTooSmall = next.text.trim().length < minSectionChars;
    const shouldMerge =
      combinedTokens <= Math.floor(targetTokens * 1.15) &&
      (currentTooSmall || nextTooSmall);

    if (shouldMerge) {
      current = {
        pageNumber: current.pageNumber,
        sectionTitle: mergeSectionTitles([
          current.sectionTitle,
          next.sectionTitle,
        ]),
        text: combinedText,
      };
      continue;
    }

    merged.push(current);
    current = next;
  }

  merged.push(current);
  return merged;
}

function buildParagraphOverlap(
  paragraphs: string[],
  overlapTokens: number,
): string[] {
  if (overlapTokens <= 0 || paragraphs.length === 0) {
    return [];
  }

  const overlap: string[] = [];
  let tokenCount = 0;
  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    const paragraph = paragraphs[index]!;
    const paragraphTokens = countTokens(paragraph);
    overlap.unshift(paragraph);
    tokenCount += paragraphTokens;
    if (tokenCount >= overlapTokens) {
      break;
    }
  }
  return overlap;
}

/**
 * Splits a table too large for one chunk on row boundaries, repeating the
 * header on every piece. Word-slicing it (the prose path) would cut mid-row and
 * strand cells from their column labels — the failure the table reconstruction
 * exists to prevent.
 */
function chunkOversizedTable(table: string, targetTokens: number): string[] {
  const rows = table.split("\n");
  const header: string[] = [];
  if (rows[0] && isTableRow(rows[0])) {
    header.push(rows[0]);
    if (rows[1] && isTableSeparatorRow(rows[1])) {
      header.push(rows[1]);
    }
  }

  const body = rows.slice(header.length);
  const headerText = header.join("\n");
  const headerTokens = header.length > 0 ? countTokens(headerText) : 0;

  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = headerTokens;

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    chunks.push([...header, ...current].join("\n"));
    current = [];
    currentTokens = headerTokens;
  };

  for (const row of body) {
    const rowTokens = countTokens(row);
    if (current.length > 0 && currentTokens + rowTokens > targetTokens) {
      flush();
    }
    current.push(row);
    currentTokens += rowTokens;
  }
  flush();

  return chunks.length > 0 ? chunks : [table];
}

function chunkOversizedParagraph(
  paragraph: string,
  targetTokens: number,
  overlapTokens: number,
): string[] {
  const tokens = tokenize(paragraph);

  // Slicing happens at word boundaries, but the budget is BPE tokens. The
  // paragraph's own words-per-BPE ratio converts the budgets into word
  // windows, adapting to language and compression.
  const wordsPerBpeToken = tokens.length / Math.max(1, countTokens(paragraph));
  const wordBudget = Math.max(1, Math.floor(targetTokens * wordsPerBpeToken));
  const overlapWordBudget = Math.max(
    0,
    Math.floor(overlapTokens * wordsPerBpeToken),
  );

  const chunks: string[] = [];
  let start = 0;

  while (start < tokens.length) {
    const rawEnd = Math.min(start + wordBudget, tokens.length);
    const end =
      rawEnd < tokens.length
        ? findSentenceBoundary(tokens, rawEnd, tokens.length)
        : rawEnd;
    const content = decodeTokens(tokens, start, end).trim();
    if (content) {
      chunks.push(content);
    }
    if (end >= tokens.length) {
      break;
    }
    start = Math.max(end - overlapWordBudget, start + 1);
  }

  return chunks;
}

export function chunkSections(input: {
  sections: Section[];
  language: SupportedLanguage;
  targetTokens: number;
  overlapTokens: number;
  minChars: number;
}): ChunkCandidate[] {
  const { sections, language, targetTokens, overlapTokens, minChars } = input;

  if (targetTokens <= 0) {
    throw new Error("targetTokens must be positive");
  }
  if (overlapTokens < 0) {
    throw new Error("overlapTokens cannot be negative");
  }
  if (overlapTokens >= targetTokens) {
    throw new Error("overlapTokens must be smaller than targetTokens");
  }

  const chunks: ChunkCandidate[] = [];
  let chunkIndex = 0;

  for (const section of mergeAdjacentSections(
    sections,
    targetTokens,
    minChars,
  )) {
    if (!section.text) {
      continue;
    }

    const normalizedSectionText = section.text.replace(/\s+/g, " ").trim();
    if (!normalizedSectionText) {
      continue;
    }

    // The whitespace-collapsed form is only an emptiness probe. A section
    // holding a table has to keep its newlines in the fallback chunk below, or
    // the relaxed path silently undoes the reconstruction.
    const fallbackContent = section.text.split("\n").some(isTableRow)
      ? section.text.trim()
      : normalizedSectionText;

    const paragraphs = splitIntoParagraphs(section.text);
    let paragraphIndex = 0;
    let overlapParagraphs: string[] = [];
    let emittedSectionChunk = false;

    while (paragraphIndex < paragraphs.length) {
      const chunkParagraphs = [...overlapParagraphs];
      let chunkTokenCount = chunkParagraphs.reduce(
        (sum, paragraph) => sum + countTokens(paragraph),
        0,
      );
      let addedFreshParagraph = false;

      while (paragraphIndex < paragraphs.length) {
        const paragraph = paragraphs[paragraphIndex]!;
        const paragraphTokens = countTokens(paragraph);

        if (paragraphTokens > targetTokens) {
          if (addedFreshParagraph || chunkTokenCount > 0) {
            break;
          }

          const oversizedParagraphChunks = isTableRow(
            paragraph.split("\n")[0] ?? "",
          )
            ? chunkOversizedTable(paragraph, targetTokens)
            : chunkOversizedParagraph(paragraph, targetTokens, overlapTokens);
          for (const oversizedContent of oversizedParagraphChunks) {
            if (
              oversizedContent.length < minChars &&
              oversizedContent.length < RELAXED_MIN_CHARS
            ) {
              continue;
            }
            chunks.push({
              chunkIndex,
              pageNumber: section.pageNumber,
              sectionTitle: section.sectionTitle,
              content: oversizedContent,
              language,
            });
            chunkIndex += 1;
            emittedSectionChunk = true;
          }
          paragraphIndex += 1;
          overlapParagraphs = [];
          addedFreshParagraph = true;
          break;
        }

        if (
          chunkTokenCount > 0 &&
          chunkTokenCount + paragraphTokens > targetTokens
        ) {
          if (!addedFreshParagraph) {
            overlapParagraphs = [];
            chunkParagraphs.length = 0;
            chunkTokenCount = 0;
            continue;
          }
          break;
        }

        chunkParagraphs.push(paragraph);
        chunkTokenCount += paragraphTokens;
        paragraphIndex += 1;
        addedFreshParagraph = true;
      }

      const content = chunkParagraphs.join("\n\n").trim();
      if (content.length >= minChars) {
        chunks.push({
          chunkIndex,
          pageNumber: section.pageNumber,
          sectionTitle: section.sectionTitle,
          content,
          language,
        });
        chunkIndex += 1;
        emittedSectionChunk = true;
        overlapParagraphs = buildParagraphOverlap(
          chunkParagraphs,
          overlapTokens,
        );
      }
    }

    // Keep short but meaningful sections indexable instead of failing ingestion.
    if (
      !emittedSectionChunk &&
      normalizedSectionText.length >= Math.min(minChars, RELAXED_MIN_CHARS)
    ) {
      chunks.push({
        chunkIndex,
        pageNumber: section.pageNumber,
        sectionTitle: section.sectionTitle,
        content: fallbackContent,
        language,
      });
      chunkIndex += 1;
    }
  }

  return chunks;
}
