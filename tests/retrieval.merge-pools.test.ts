import assert from "node:assert/strict";
import test from "node:test";
import type { RetrievedChunk } from "../lib/contracts/retrieval";

function ensureRetrievalTestEnv(): void {
  process.env.SUPABASE_URL ??= "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY ??= "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-key";
  process.env.OPENAI_API_KEY ??= "test-openai-key";
}

function buildChunk(overrides: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    chunkId: "chunk-1",
    documentId: "doc-1",
    pageNumber: 1,
    sectionTitle: "Overview",
    content: "content",
    context: "context",
    language: "EN",
    source: "hybrid",
    retrievalScore: 0.2,
    ...overrides,
  };
}

test("mergeCandidatePools dedupes by chunkId keeping the best relevanceScore", async () => {
  ensureRetrievalTestEnv();
  const { mergeCandidatePools } = await import("../lib/retrieval/router");

  const merged = mergeCandidatePools([
    [
      buildChunk({
        chunkId: "a",
        relevanceScore: 0.5,
        scoreScale: "cross_encoder",
      }),
      buildChunk({
        chunkId: "b",
        relevanceScore: 0.4,
        scoreScale: "cross_encoder",
      }),
    ],
    [
      buildChunk({
        chunkId: "a",
        relevanceScore: 0.7,
        scoreScale: "cross_encoder",
      }),
      buildChunk({
        chunkId: "c",
        relevanceScore: 0.3,
        scoreScale: "cross_encoder",
      }),
    ],
  ]);

  assert.deepEqual(
    merged.map((chunk) => chunk.chunkId),
    ["a", "b", "c"],
  );
  assert.equal(merged[0]?.relevanceScore, 0.7);
});

test("mergeCandidatePools never shrinks the pool below a single branch", async () => {
  ensureRetrievalTestEnv();
  const { mergeCandidatePools } = await import("../lib/retrieval/router");

  const branchA = [
    buildChunk({
      chunkId: "a",
      relevanceScore: 0.6,
      scoreScale: "cross_encoder",
    }),
    buildChunk({
      chunkId: "b",
      relevanceScore: 0.5,
      scoreScale: "cross_encoder",
    }),
    buildChunk({
      chunkId: "c",
      relevanceScore: 0.4,
      scoreScale: "cross_encoder",
    }),
  ];
  const branchB = [
    buildChunk({
      chunkId: "d",
      relevanceScore: 0.35,
      scoreScale: "cross_encoder",
    }),
    buildChunk({
      chunkId: "b",
      relevanceScore: 0.3,
      scoreScale: "cross_encoder",
    }),
  ];

  const merged = mergeCandidatePools([branchA, branchB]);

  // Every distinct chunk from every branch survives the merge: no rank
  // fusion, no trimming to a fixed pool width.
  assert.equal(merged.length, 4);
  assert.ok(merged.length >= branchA.length);
  assert.ok(merged.length >= branchB.length);
  // Branch A's better score for "b" wins over branch B's.
  assert.equal(
    merged.find((chunk) => chunk.chunkId === "b")?.relevanceScore,
    0.5,
  );
});

test("mergeCandidatePools sorts by resolved relevance, descending", async () => {
  ensureRetrievalTestEnv();
  const { mergeCandidatePools } = await import("../lib/retrieval/router");

  const merged = mergeCandidatePools([
    [
      buildChunk({
        chunkId: "low",
        relevanceScore: 0.1,
        scoreScale: "cross_encoder",
      }),
      // No relevanceScore: falls back to rerankScore, like the evidence gate.
      buildChunk({ chunkId: "legacy", rerankScore: 0.45 }),
    ],
    [
      buildChunk({
        chunkId: "high",
        relevanceScore: 0.8,
        scoreScale: "cross_encoder",
      }),
    ],
  ]);

  assert.deepEqual(
    merged.map((chunk) => chunk.chunkId),
    ["high", "legacy", "low"],
  );
});
