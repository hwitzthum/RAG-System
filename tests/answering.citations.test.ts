import assert from "node:assert/strict";
import test from "node:test";
import { resolveCitedChunks } from "../lib/answering/citations";
import type { RetrievedChunk } from "../lib/contracts/retrieval";

function buildChunks(count: number): RetrievedChunk[] {
  return Array.from({ length: count }, (_, index) => ({
    chunkId: `chunk-${index + 1}`,
    documentId: `doc-${index + 1}`,
    pageNumber: index + 1,
    sectionTitle: "Overview",
    content: "content",
    context: "context",
    language: "EN" as const,
    source: "hybrid" as const,
    retrievalScore: 0.5,
  }));
}

test("resolveCitedChunks returns only the chunks the answer cites", () => {
  const result = resolveCitedChunks({
    answer: "The term is five years [2]. Renewal is automatic [4].",
    chunks: buildChunks(8),
  });

  assert.deepEqual(
    result.citations.map((citation) => citation.chunkId),
    ["chunk-2", "chunk-4"],
  );
  assert.deepEqual(
    result.citations.map((citation) => citation.evidenceIndex),
    [2, 4],
  );
  assert.equal(result.markerCount, 2);
  assert.equal(result.fellBack, false);
});

test("resolveCitedChunks parses grouped markers like [1, 3]", () => {
  const result = resolveCitedChunks({
    answer: "Both sections agree [1, 3].",
    chunks: buildChunks(4),
  });

  assert.deepEqual(
    result.citations.map((citation) => citation.chunkId),
    ["chunk-1", "chunk-3"],
  );
});

test("resolveCitedChunks preserves first-appearance order and deduplicates", () => {
  const result = resolveCitedChunks({
    answer: "First [3]. Then [1]. Again [3].",
    chunks: buildChunks(5),
  });

  assert.deepEqual(
    result.citations.map((citation) => citation.evidenceIndex),
    [3, 1],
  );
  assert.equal(result.markerCount, 2);
});

test("resolveCitedChunks ignores [WEB-n] markers", () => {
  // buildWebAugmentedUserPrompt numbers web sources [WEB-1], [WEB-2]. Those are
  // not document evidence and must never resolve to a chunk index.
  const result = resolveCitedChunks({
    answer: "Per the filing [1], and per the web [WEB-2].",
    chunks: buildChunks(3),
  });

  assert.deepEqual(
    result.citations.map((citation) => citation.evidenceIndex),
    [1],
  );
  assert.equal(result.invalidMarkerCount, 0);
});

test("resolveCitedChunks counts out-of-range markers without emitting them", () => {
  const result = resolveCitedChunks({
    answer: "Valid [1]. Hallucinated [9].",
    chunks: buildChunks(3),
  });

  assert.deepEqual(
    result.citations.map((citation) => citation.evidenceIndex),
    [1],
  );
  assert.equal(result.invalidMarkerCount, 1);
});

test("resolveCitedChunks falls back to every chunk when no marker is usable", () => {
  // A model that ignores the citation format must not strip the answer of all
  // provenance — fall back to the full evidence set and flag it so the rate is
  // measurable.
  const result = resolveCitedChunks({
    answer: "The contract runs for five years.",
    chunks: buildChunks(3),
  });

  assert.equal(result.citations.length, 3);
  assert.equal(result.fellBack, true);
  assert.equal(result.markerCount, 0);
});

test("resolveCitedChunks does not report a fallback when there is no evidence", () => {
  const result = resolveCitedChunks({
    answer: "No evidence available.",
    chunks: [],
  });

  assert.deepEqual(result.citations, []);
  assert.equal(result.fellBack, false);
});
