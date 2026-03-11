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

  for (const line of lines) {
    if (!line) {
      continue;
    }

    if (isHeading(line)) {
      if (currentContent.length > 0) {
        sections.push({
          pageNumber: page.pageNumber,
          sectionTitle: currentTitle,
          text: currentContent.join("\n").trim(),
        });
        currentContent = [];
      }
      currentTitle = line
        .toLowerCase()
        .replace(/\b\w/g, (character) => character.toUpperCase());
      continue;
    }

    currentContent.push(line);
  }

  if (currentContent.length > 0) {
    sections.push({
      pageNumber: page.pageNumber,
      sectionTitle: currentTitle,
      text: currentContent.join("\n").trim(),
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

  for (const section of sections) {
    if (!section.text) {
      continue;
    }

    const normalizedSectionText = section.text.replace(/\s+/g, " ").trim();
    if (!normalizedSectionText) {
      continue;
    }

    const tokens = tokenize(section.text);
    const totalTokens = tokens.length;
    let start = 0;
    let emittedSectionChunk = false;

    while (start < totalTokens) {
      const end = Math.min(start + targetTokens, totalTokens);
      const content = decodeTokens(tokens, start, end).trim();

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
      }

      if (end >= totalTokens) {
        break;
      }

      start = Math.max(end - overlapTokens, start + 1);
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
