import assert from "node:assert/strict";
import test from "node:test";
import type { RetrievedChunk } from "../lib/contracts/retrieval";
import { applyContextualGrouping } from "../lib/retrieval/contextual-grouping";

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
    ...overrides,
  };
}

test("the adjacency boost is additive and capped at two neighbours", () => {
  const chunks = [
    buildChunk({ chunkId: "a", pageNumber: 1, rerankScore: 0.4 }),
    buildChunk({ chunkId: "b", pageNumber: 2, rerankScore: 0.4 }),
    buildChunk({ chunkId: "c", pageNumber: 3, rerankScore: 0.4 }),
  ];

  const ordered = applyContextualGrouping(chunks);
  const score = (id: string) =>
    ordered.find((chunk) => chunk.chunkId === id)?.rerankScore ?? 0;

  // Interior chunk has two neighbours, the edges one each.
  assert.ok(Math.abs(score("b") - 0.5) < 1e-9);
  assert.ok(Math.abs(score("a") - 0.45) < 1e-9);
  assert.ok(Math.abs(score("c") - 0.45) < 1e-9);
});

test("adjacency breaks ties between comparable candidates", () => {
  const chunks = [
    buildChunk({
      chunkId: "isolated",
      documentId: "doc-2",
      pageNumber: 40,
      rerankScore: 0.5,
    }),
    buildChunk({ chunkId: "neighboured-a", pageNumber: 1, rerankScore: 0.5 }),
    buildChunk({ chunkId: "neighboured-b", pageNumber: 2, rerankScore: 0.5 }),
  ];

  const ordered = applyContextualGrouping(chunks);

  assert.equal(ordered[ordered.length - 1]?.chunkId, "isolated");
});

test("relevanceScore is never touched, only the ordering score", () => {
  const chunks = [
    buildChunk({
      chunkId: "a",
      pageNumber: 1,
      rerankScore: 0.4,
      relevanceScore: 0.2,
    }),
    buildChunk({
      chunkId: "b",
      pageNumber: 2,
      rerankScore: 0.4,
      relevanceScore: 0.2,
    }),
  ];

  for (const chunk of applyContextualGrouping(chunks)) {
    // The evidence gate reads relevanceScore; page adjacency must not make
    // weak evidence look sufficient.
    assert.equal(chunk.relevanceScore, 0.2);
  }
});

test("chunks retrieved from the same page currently boost each other", () => {
  // Documents the known defect, so a fix that changes it fails loudly rather
  // than silently: the page gap is compared with <= 1, so a 0-page gap counts
  // as adjacency. See the comment on ADJACENCY_BOOST -- the real fix is to key
  // adjacency on chunk_index instead.
  const chunks = [
    buildChunk({ chunkId: "a", pageNumber: 1, rerankScore: 0.4 }),
    buildChunk({ chunkId: "b", pageNumber: 1, rerankScore: 0.4 }),
  ];

  const ordered = applyContextualGrouping(chunks);

  for (const chunk of ordered) {
    assert.ok(Math.abs((chunk.rerankScore ?? 0) - 0.45) < 1e-9);
  }
});

test("the boost magnitude parameter is honored", () => {
  const chunks = [
    buildChunk({ chunkId: "a", pageNumber: 1, rerankScore: 0.4 }),
    buildChunk({ chunkId: "b", pageNumber: 2, rerankScore: 0.4 }),
  ];

  const ordered = applyContextualGrouping(chunks, 0.01);
  const score = (id: string) =>
    ordered.find((chunk) => chunk.chunkId === id)?.rerankScore ?? 0;

  assert.ok(Math.abs(score("a") - 0.41) < 1e-9);
  assert.ok(Math.abs(score("b") - 0.41) < 1e-9);
});

test("a zero boost degrades to a stable score-ordered pass-through", () => {
  const chunks = [
    buildChunk({ chunkId: "top", pageNumber: 5, rerankScore: 0.9 }),
    buildChunk({ chunkId: "mid", pageNumber: 6, rerankScore: 0.7 }),
    buildChunk({
      chunkId: "low",
      documentId: "doc-2",
      pageNumber: 1,
      rerankScore: 0.5,
    }),
  ];

  const ordered = applyContextualGrouping(chunks, 0);

  assert.deepEqual(
    ordered.map((chunk) => chunk.chunkId),
    ["top", "mid", "low"],
  );
  assert.deepEqual(
    ordered.map((chunk) => chunk.rerankScore),
    [0.9, 0.7, 0.5],
  );
});
