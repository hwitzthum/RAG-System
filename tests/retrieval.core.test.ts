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
  });

  assert.equal(reranked[0]?.chunkId, "match");
  assert.ok((reranked[0]?.rerankScore ?? 0) > (reranked[1]?.rerankScore ?? 0));
});

test("rerankCandidates emits an absolute relevance score independent of the pool", () => {
  // A pool of uniformly weak candidates. rerankScore normalises against the
  // pool leader so it stays high; relevanceScore must stay low, because that is
  // the number the evidence gate reads.
  const weakPool = [
    buildChunk({
      chunkId: "weak-1",
      retrievalScore: 0.016,
      vectorScore: 0.07,
      content: "Completely unrelated boilerplate.",
      context: "unrelated",
      sectionTitle: "Appendix",
    }),
    buildChunk({
      chunkId: "weak-2",
      retrievalScore: 0.015,
      vectorScore: 0.05,
      content: "Also unrelated.",
      context: "unrelated",
      sectionTitle: "Appendix",
    }),
  ];

  const reranked = rerankCandidates({
    normalizedQuery: "solar financing",
    candidates: weakPool,
    poolSize: 20,
  });

  assert.equal(reranked[0]?.scoreScale, "heuristic");
  assert.ok(
    (reranked[0]?.rerankScore ?? 0) > 0.5,
    "pool leader should still order near the top",
  );
  assert.ok(
    (reranked[0]?.relevanceScore ?? 1) < 0.15,
    "absolute relevance must reflect that nothing in the pool is relevant",
  );
});

test("rerankCandidates scores a genuinely relevant chunk highly in absolute terms", () => {
  const reranked = rerankCandidates({
    normalizedQuery: "solar financing",
    candidates: [
      buildChunk({
        chunkId: "match",
        retrievalScore: 0.016,
        vectorScore: 0.62,
        sectionTitle: "Solar Financing",
        content: "Solar financing options for schools.",
        context: "loan and subsidy comparisons",
      }),
    ],
    poolSize: 20,
  });

  assert.ok((reranked[0]?.relevanceScore ?? 0) > 0.5);
});

test("rerankCandidates applies a language match boost to ordering only", () => {
  const candidates = [
    buildChunk({
      chunkId: "en",
      language: "EN",
      retrievalScore: 0.016,
      vectorScore: 0.4,
      content: "shared body text",
      context: "shared",
      sectionTitle: "Shared",
    }),
    buildChunk({
      chunkId: "de",
      language: "DE",
      retrievalScore: 0.016,
      vectorScore: 0.4,
      content: "shared body text",
      context: "shared",
      sectionTitle: "Shared",
    }),
  ];

  const reranked = rerankCandidates({
    normalizedQuery: "vertragslaufzeit",
    candidates,
    poolSize: 20,
    language: "DE",
  });

  assert.equal(
    reranked[0]?.chunkId,
    "de",
    "same-language chunk should order first",
  );
  // The boost must not leak into the gate score: both chunks are equally
  // (ir)relevant to the query regardless of which language they are in.
  assert.equal(reranked[0]?.relevanceScore, reranked[1]?.relevanceScore);
});

test("detectQueryLanguage keeps EN when no language keyword matches", () => {
  // Regression: bestScore seeded at -1 let a zero-scoring query be won by the
  // first key in LANGUAGE_KEYWORDS (DE), so English questions containing none
  // of the tracked stopwords were answered in German.
  assert.equal(
    detectQueryLanguage(
      "how does artificial intelligence affect employee wellbeing",
    ),
    "EN",
  );
  assert.equal(detectQueryLanguage("melting point tungsten carbide"), "EN");
});

test("detectQueryLanguage still detects a language from its keywords", () => {
  assert.equal(
    detectQueryLanguage("was ist der inhalt und die struktur"),
    "DE",
  );
  assert.equal(
    detectQueryLanguage("what is the content and the structure"),
    "EN",
  );
});
