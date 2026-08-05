import assert from "node:assert/strict";
import test from "node:test";
import type { RetrievedChunk } from "../lib/contracts/retrieval";
import { applyDocumentDiversity } from "../lib/retrieval/diversity";

function buildChunk(overrides: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    chunkId: "chunk-1",
    documentId: "doc-1",
    pageNumber: 1,
    sectionTitle: "Overview",
    content: "content",
    context: "context",
    language: "EN",
    source: "vector",
    retrievalScore: 0.5,
    rerankScore: 0.5,
    relevanceScore: 0.5,
    scoreScale: "cross_encoder",
    ...overrides,
  };
}

const OPTIONS = { topK: 4, maxPerDocument: 3, relevanceFloor: 0.25 };

test("maxPerDocument 0 disables the stage and returns the input unchanged", () => {
  const chunks = [buildChunk({ chunkId: "a" }), buildChunk({ chunkId: "b" })];
  const result = applyDocumentDiversity(chunks, {
    ...OPTIONS,
    maxPerDocument: 0,
  });
  assert.equal(result, chunks);
});

test("promotes the best qualifying alternate-document chunk into a reserved slot", () => {
  const chunks = [
    buildChunk({ chunkId: "a1", rerankScore: 0.9 }),
    buildChunk({ chunkId: "a2", rerankScore: 0.8 }),
    buildChunk({ chunkId: "a3", rerankScore: 0.7 }),
    buildChunk({ chunkId: "a4", rerankScore: 0.6 }),
    buildChunk({
      chunkId: "b1",
      documentId: "doc-2",
      rerankScore: 0.5,
      relevanceScore: 0.5,
    }),
    buildChunk({
      chunkId: "b2",
      documentId: "doc-2",
      rerankScore: 0.4,
      relevanceScore: 0.4,
    }),
  ];

  const result = applyDocumentDiversity(chunks, OPTIONS).slice(0, 4);
  assert.deepEqual(
    result.map((chunk) => chunk.chunkId),
    ["a1", "a2", "a3", "b1"],
  );
});

test("cap is inert when every candidate shares one document (backfill path)", () => {
  const chunks = [
    buildChunk({ chunkId: "a1", rerankScore: 0.9 }),
    buildChunk({ chunkId: "a2", rerankScore: 0.8 }),
    buildChunk({ chunkId: "a3", rerankScore: 0.7 }),
    buildChunk({ chunkId: "a4", rerankScore: 0.6 }),
    buildChunk({ chunkId: "a5", rerankScore: 0.5 }),
  ];

  const result = applyDocumentDiversity(chunks, OPTIONS).slice(0, 4);
  assert.deepEqual(
    result.map((chunk) => chunk.chunkId),
    ["a1", "a2", "a3", "a4"],
  );
});

test("never promotes heuristic-scale chunks nor chunks below the floor", () => {
  const chunks = [
    buildChunk({ chunkId: "a1", rerankScore: 0.9 }),
    buildChunk({ chunkId: "a2", rerankScore: 0.8 }),
    buildChunk({ chunkId: "a3", rerankScore: 0.7 }),
    buildChunk({ chunkId: "a4", rerankScore: 0.6 }),
    buildChunk({
      chunkId: "b-heuristic",
      documentId: "doc-2",
      relevanceScore: 0.9,
      scoreScale: "heuristic",
    }),
    buildChunk({
      chunkId: "c-below-floor",
      documentId: "doc-3",
      relevanceScore: 0.1,
    }),
  ];

  const result = applyDocumentDiversity(chunks, OPTIONS).slice(0, 4);
  assert.deepEqual(
    result.map((chunk) => chunk.chunkId),
    ["a1", "a2", "a3", "a4"],
  );
});

test("scores are never mutated and non-displaced ordering is preserved", () => {
  const chunks = [
    buildChunk({ chunkId: "a1", rerankScore: 0.9, relevanceScore: 0.91 }),
    buildChunk({ chunkId: "a2", rerankScore: 0.8, relevanceScore: 0.81 }),
    buildChunk({ chunkId: "a3", rerankScore: 0.7, relevanceScore: 0.71 }),
    buildChunk({ chunkId: "a4", rerankScore: 0.6, relevanceScore: 0.61 }),
    buildChunk({
      chunkId: "b1",
      documentId: "doc-2",
      rerankScore: 0.5,
      relevanceScore: 0.51,
    }),
  ];
  const before = chunks.map((chunk) => ({ ...chunk }));

  const result = applyDocumentDiversity(chunks, OPTIONS);

  for (const original of before) {
    const after = result.find((chunk) => chunk.chunkId === original.chunkId);
    assert.ok(after);
    assert.equal(after.rerankScore, original.rerankScore);
    assert.equal(after.relevanceScore, original.relevanceScore);
  }
  // a1..a3 keep their relative order ahead of the promoted b1.
  const ids = result.map((chunk) => chunk.chunkId);
  assert.ok(ids.indexOf("a1") < ids.indexOf("a2"));
  assert.ok(ids.indexOf("a2") < ids.indexOf("a3"));
  assert.deepEqual(ids.slice(0, 4), ["a1", "a2", "a3", "b1"]);
});

test("input shorter than topK is returned unchanged", () => {
  const chunks = [buildChunk({ chunkId: "a1" }), buildChunk({ chunkId: "a2" })];
  const result = applyDocumentDiversity(chunks, OPTIONS);
  assert.equal(result, chunks);
});
