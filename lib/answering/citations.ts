import type { Citation, RetrievedChunk } from "@/lib/contracts/retrieval";

export type CitationAttribution = {
  /**
   * The answer with out-of-range markers removed. Identical to the input when
   * every marker resolved.
   */
  answer: string;
  citations: Citation[];
  /** Distinct in-range markers the model wrote. */
  markerCount: number;
  /** Markers pointing outside the evidence set (e.g. "[9]" with 8 chunks). */
  invalidMarkerCount: number;
  /** True when no usable marker was found and every chunk was returned instead. */
  fellBack: boolean;
};

// Matches "[1]" and "[1, 3]" but deliberately not "[WEB-1]", the marker
// lib/answering/web-augmented-prompts.ts assigns to web sources — those are not
// document citations and must not resolve to a chunk index.
//
// The leading `[ \t]*` is horizontal-only so that removing a marker at the
// start of a line does not swallow the preceding newline. It exists so that
// dropping a dangling marker leaves "the figure fell." rather than
// "the figure fell ."
const EVIDENCE_MARKER_PATTERN = /([ \t]*)\[(\d+(?:\s*,\s*\d+)*)\]/g;

function toCitation(chunk: RetrievedChunk, evidenceIndex: number): Citation {
  return {
    documentId: chunk.documentId,
    pageNumber: chunk.pageNumber,
    chunkId: chunk.chunkId,
    evidenceIndex,
  };
}

/**
 * Resolves the `[n]` markers in a generated answer back to the chunks they
 * refer to.
 *
 * Citations were previously every retrieved chunk, deduped — so an answer that
 * drew on two of eight chunks still reported eight sources, and the eval
 * harness's citationAccuracy metric measured retrieval rather than attribution.
 *
 * Marker indices are 1-based to match `formatEvidenceChunk` in
 * lib/answering/prompts.ts, which renders `index="${index + 1}"`.
 *
 * When the model writes no usable marker, this returns every chunk and sets
 * `fellBack`. Returning nothing would be worse: a model that ignores the output
 * format would silently strip an answer of all provenance. The flag makes the
 * fallback rate measurable instead of invisible.
 *
 * Out-of-range markers are stripped from the returned `answer`. Counting them
 * and leaving them in the prose shipped an answer citing "[9]" against eight
 * chunks, with nothing in the Evidence Navigator for the reader to open.
 */
export function resolveCitedChunks(input: {
  answer: string;
  chunks: RetrievedChunk[];
}): CitationAttribution {
  const allCitations = input.chunks.map((chunk, index) =>
    toCitation(chunk, index + 1),
  );

  if (input.chunks.length === 0) {
    return {
      answer: input.answer,
      citations: [],
      markerCount: 0,
      invalidMarkerCount: 0,
      fellBack: false,
    };
  }

  const seenIndexes = new Set<number>();
  const citations: Citation[] = [];
  let invalidMarkerCount = 0;

  const sanitizedAnswer = input.answer.replace(
    EVIDENCE_MARKER_PATTERN,
    (match, leadingSpace: string, indexList: string) => {
      const resolvedIndexes: number[] = [];

      for (const rawIndex of indexList.split(",")) {
        const evidenceIndex = Number.parseInt(rawIndex.trim(), 10);
        if (!Number.isInteger(evidenceIndex)) {
          continue;
        }

        const chunk = input.chunks[evidenceIndex - 1];
        if (!chunk) {
          invalidMarkerCount += 1;
          continue;
        }

        resolvedIndexes.push(evidenceIndex);

        if (seenIndexes.has(evidenceIndex)) {
          continue;
        }

        seenIndexes.add(evidenceIndex);
        citations.push(toCitation(chunk, evidenceIndex));
      }

      if (resolvedIndexes.length === 0) {
        return "";
      }

      // Rewrite only when part of a compound marker was dropped, so an answer
      // whose markers all resolved comes back byte-identical.
      return resolvedIndexes.length === indexList.split(",").length
        ? match
        : `${leadingSpace}[${resolvedIndexes.join(", ")}]`;
    },
  );

  if (citations.length === 0) {
    return {
      answer: sanitizedAnswer,
      citations: allCitations,
      markerCount: 0,
      invalidMarkerCount,
      fellBack: true,
    };
  }

  return {
    answer: sanitizedAnswer,
    citations,
    markerCount: citations.length,
    invalidMarkerCount,
    fellBack: false,
  };
}
