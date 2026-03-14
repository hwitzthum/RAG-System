import type { ChunkCandidate, ExtractedPage, Section } from "@/lib/ingestion/runtime/types";
import type { SupportedLanguage } from "@/lib/supabase/database.types";

// Match headings in ALL CAPS or Title Case (with optional leading numbering like "1.2 Section Name").
const HEADING_UPPERCASE = /^(?:\d+(?:\.\d+)*\s+)?[A-Z\u00C4\u00D6\u00DC0-9][A-Z\u00C4\u00D6\u00DC0-9\s:/-]{3,}$/;
const HEADING_TITLECASE = /^(?:\d+(?:\.\d+)*\s+)?[A-Z\u00C0-\u00DC][a-z\u00E0-\u00FF]+(?:\s+(?:[A-Z\u00C0-\u00DC][a-z\u00E0-\u00FF]+|and|or|of|the|for|in|on|to|with|&|\/|-)){1,10}$/;
const RELAXED_MIN_CHARS = 20;

function isHeading(line: string): boolean {
  const candidate = line.trim();
  if (!candidate) {
    return false;
  }
  if (candidate.length > 120) {
    return false;
  }
  return HEADING_UPPERCASE.test(candidate) || HEADING_TITLECASE.test(candidate);
}

export function splitIntoSections(page: ExtractedPage): Section[] {
  const lines = page.text.split(/\r?\n/).map((line) => line.trim());
  const sections: Section[] = [];

  let currentTitle = `Page ${page.pageNumber}`;
  let currentContent: string[] = [];
  let previousLineWasBlank = false;

  for (const line of lines) {
    if (!line) {
      if (currentContent.length > 0 && !previousLineWasBlank) {
        currentContent.push("");
      }
      previousLineWasBlank = true;
      continue;
    }

    if (isHeading(line)) {
      if (currentContent.length > 0) {
        sections.push({
          pageNumber: page.pageNumber,
          sectionTitle: currentTitle,
          text: currentContent.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
        });
        currentContent = [];
      }
      currentTitle = line
        .toLowerCase()
        .replace(/\b\w/g, (character) => character.toUpperCase());
      previousLineWasBlank = false;
      continue;
    }

    currentContent.push(line);
    previousLineWasBlank = false;
  }

  if (currentContent.length > 0) {
    sections.push({
      pageNumber: page.pageNumber,
      sectionTitle: currentTitle,
      text: currentContent.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    });
  }

  if (sections.length === 0 && page.text.trim()) {
    sections.push({
      pageNumber: page.pageNumber,
      sectionTitle: `Page ${page.pageNumber}`,
      text: page.text.trim(),
    });
  }

  return sections;
}

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((part) => part.length > 0);
}

function decodeTokens(tokens: string[], tokenStart: number, tokenEnd: number): string {
  return tokens.slice(tokenStart, tokenEnd).join(" ");
}

function countTokens(text: string): number {
  return tokenize(text).length;
}

const SENTENCE_END_PATTERN = /[.!?]$/;
const SCAN_RADIUS = 50;

function findSentenceBoundary(tokens: string[], nominalEnd: number, totalTokens: number): number {
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
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim());
  const paragraphs: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    paragraphs.push(current.join(" ").replace(/\s+/g, " ").trim());
    current = [];
  };

  for (const line of lines) {
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
  return paragraphs.filter((paragraph) => paragraph.length > 0);
}

function mergeSectionTitles(titles: string[]): string {
  const deduped = titles.filter((title, index) => titles.indexOf(title) === index);
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
        sectionTitle: mergeSectionTitles([current.sectionTitle, next.sectionTitle]),
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

function buildParagraphOverlap(paragraphs: string[], overlapTokens: number): string[] {
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

function chunkOversizedParagraph(
  paragraph: string,
  targetTokens: number,
  overlapTokens: number,
): string[] {
  const tokens = tokenize(paragraph);
  const chunks: string[] = [];
  let start = 0;

  while (start < tokens.length) {
    const rawEnd = Math.min(start + targetTokens, tokens.length);
    const end = rawEnd < tokens.length ? findSentenceBoundary(tokens, rawEnd, tokens.length) : rawEnd;
    const content = decodeTokens(tokens, start, end).trim();
    if (content) {
      chunks.push(content);
    }
    if (end >= tokens.length) {
      break;
    }
    start = Math.max(end - overlapTokens, start + 1);
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

  for (const section of mergeAdjacentSections(sections, targetTokens, minChars)) {
    if (!section.text) {
      continue;
    }

    const normalizedSectionText = section.text.replace(/\s+/g, " ").trim();
    if (!normalizedSectionText) {
      continue;
    }

    const paragraphs = splitIntoParagraphs(section.text);
    let paragraphIndex = 0;
    let overlapParagraphs: string[] = [];
    let emittedSectionChunk = false;

    while (paragraphIndex < paragraphs.length) {
      const chunkParagraphs = [...overlapParagraphs];
      let chunkTokenCount = chunkParagraphs.reduce((sum, paragraph) => sum + countTokens(paragraph), 0);
      let addedFreshParagraph = false;

      while (paragraphIndex < paragraphs.length) {
        const paragraph = paragraphs[paragraphIndex]!;
        const paragraphTokens = countTokens(paragraph);

        if (paragraphTokens > targetTokens) {
          if (addedFreshParagraph || chunkTokenCount > 0) {
            break;
          }

          const oversizedParagraphChunks = chunkOversizedParagraph(paragraph, targetTokens, overlapTokens);
          for (const oversizedContent of oversizedParagraphChunks) {
            if (oversizedContent.length < minChars && oversizedContent.length < RELAXED_MIN_CHARS) {
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

        if (chunkTokenCount > 0 && chunkTokenCount + paragraphTokens > targetTokens) {
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
        overlapParagraphs = buildParagraphOverlap(chunkParagraphs, overlapTokens);
      }
    }

    // Keep short but meaningful sections indexable instead of failing ingestion.
    if (!emittedSectionChunk && normalizedSectionText.length >= Math.min(minChars, RELAXED_MIN_CHARS)) {
      chunks.push({
        chunkIndex,
        pageNumber: section.pageNumber,
        sectionTitle: section.sectionTitle,
        content: normalizedSectionText,
        language,
      });
      chunkIndex += 1;
    }
  }

  return chunks;
}
