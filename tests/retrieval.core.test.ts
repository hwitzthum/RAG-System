import assert from "node:assert/strict";
import test from "node:test";
import type { RetrievedChunk } from "../lib/contracts/retrieval";
import { detectQueryLanguage } from "../lib/retrieval/language";
import { extractQueryTokens, normalizeQuery } from "../lib/retrieval/query";
import { rerankCandidates } from "../lib/retrieval/reranker";
import { reciprocalRankFusion } from "../lib/retrieval/rrf";
import { buildRetrievalCacheKey } from "../lib/retrieval/trace";

function buildChunk(overrides: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    chunkId: "chunk-1",
    documentId: "doc-1",
    pageNumber: 1,
    sectionTitle: "Overview",
    content: "baseline content",
    context: "baseline context",
    language: "EN",
    source: "vector",
    retrievalScore: 0.2,
    ...overrides,
  };
}

test("normalizeQuery normalizes spacing and casing", () => {
  assert.equal(normalizeQuery("  HéLLO   WORLD \n"), "héllo world");
});

test("extractQueryTokens deduplicates and filters short tokens", () => {
  const tokens = extractQueryTokens("the the ai a retrieval retrieval");
  assert.deepEqual(tokens, ["the", "ai", "retrieval"]);
});

test("detectQueryLanguage honors hint and falls back to heuristic", () => {
  assert.equal(detectQueryLanguage("bonjour le monde", "DE"), "DE");
  assert.equal(detectQueryLanguage("der kunde und die region"), "DE");
});

test("buildRetrievalCacheKey varies by retrieval inputs", () => {
  const base = buildRetrievalCacheKey({
    normalizedQuery: "solar financing",
    language: "EN",
    retrievalVersion: 1,
    topK: 8,
    scopeKey: "scope:all",
  });
  const changed = buildRetrievalCacheKey({
    normalizedQuery: "solar financing",
    language: "EN",
    retrievalVersion: 2,
    topK: 8,
    scopeKey: "scope:all",
  });

  assert.notEqual(base, changed);
});

test("buildRetrievalCacheKey varies by scope", () => {
  const allDocs = buildRetrievalCacheKey({
    normalizedQuery: "solar financing",
    language: "EN",
    retrievalVersion: 1,
    topK: 8,
    scopeKey: "scope:all",
  });
  const scopedDocs = buildRetrievalCacheKey({
    normalizedQuery: "solar financing",
    language: "EN",
    retrievalVersion: 1,
    topK: 8,
    scopeKey: "docs:abc,def",
  });

  assert.notEqual(allDocs, scopedDocs);
});

test("reciprocalRankFusion fuses vector and keyword rankings", () => {
  const vectorCandidates = [
    buildChunk({ chunkId: "a", retrievalScore: 0.9, source: "vector" }),
    buildChunk({ chunkId: "b", retrievalScore: 0.8, source: "vector" }),
  ];
  const keywordCandidates = [
    buildChunk({ chunkId: "b", retrievalScore: 0.7, source: "keyword" }),
    buildChunk({ chunkId: "c", retrievalScore: 0.6, source: "keyword" }),
  ];

  const fused = reciprocalRankFusion({
    vectorCandidates,
    keywordCandidates,
    rrfK: 60,
  });

  assert.equal(fused.length, 3);
  assert.equal(fused[0]?.chunkId, "b");
  assert.equal(fused[0]?.source, "hybrid");
});

test("rerankCandidates prefers lexical matches in rerank pool", () => {
  const candidates = [
    buildChunk({
      chunkId: "generic",
      retrievalScore: 0.9,
      sectionTitle: "General",
      content: "No direct overlap.",
      context: "unrelated",
    }),
    buildChunk({
      chunkId: "match",
      retrievalScore: 0.6,
      sectionTitle: "Solar Financing",
      content: "Solar financing options for schools and municipalities.",
      context: "loan and subsidy comparisons",
    }),
  ];

  const reranked = rerankCandidates({
    normalizedQuery: "solar financing",
    candidates,
    poolSize: 20,
    topK: 2,
  });

  assert.equal(reranked[0]?.chunkId, "match");
  assert.ok((reranked[0]?.rerankScore ?? 0) > (reranked[1]?.rerankScore ?? 0));
});
