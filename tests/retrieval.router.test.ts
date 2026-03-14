import assert from "node:assert/strict";
import test from "node:test";
import type { RetrievedChunk, RetrievalTrace } from "../lib/contracts/retrieval";

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
    source: "vector",
    retrievalScore: 0.8,
    ...overrides,
  };
}

function buildTrace(normalizedQuery: string, candidateCounts?: Partial<RetrievalTrace["candidateCounts"]>): RetrievalTrace {
  return {
    normalizedQuery,
    language: "EN",
    cacheKey: `cache:${normalizedQuery}`,
    cacheHit: false,
    retrievalVersion: 1,
    topK: 3,
    candidateCounts: {
      vector: candidateCounts?.vector ?? 2,
      keyword: candidateCounts?.keyword ?? 1,
      fused: candidateCounts?.fused ?? 2,
      reranked: candidateCounts?.reranked ?? 2,
    },
  };
}

test("retrieveRankedCandidatesWithRouting preserves standard retrieval when expansion is disabled", async () => {
  ensureRetrievalTestEnv();
  const { retrieveRankedCandidatesWithRouting } = await import("../lib/retrieval/router");

  let retrieveCalls = 0;
  const result = await retrieveRankedCandidatesWithRouting(
    {
      query: "What is covered?",
      topK: 3,
      documentIds: ["doc-a", "doc-b"],
    },
    {
      retrieveBase: async () => {
        retrieveCalls += 1;
        return {
          chunks: [buildChunk({ chunkId: "base-1" })],
          trace: buildTrace("what is covered?"),
        };
      },
    },
  );

  assert.equal(retrieveCalls, 1);
  assert.equal(result.chunks[0]?.chunkId, "base-1");
  assert.deepEqual(result.queryExpansion, {
    requested: false,
    applied: false,
    strategy: "standard",
    variationCount: 0,
    hydeUsed: false,
    branchCount: 1,
  });
});

test("retrieveRankedCandidatesWithRouting ignores expansion for single-document scope", async () => {
  ensureRetrievalTestEnv();
  const { retrieveRankedCandidatesWithRouting } = await import("../lib/retrieval/router");

  let retrieveCalls = 0;
  let generateVariationCalls = 0;
  let generateHydeCalls = 0;

  const result = await retrieveRankedCandidatesWithRouting(
    {
      query: "Find the policy",
      topK: 3,
      documentIds: ["doc-a"],
      enableQueryExpansion: true,
    },
    {
      retrieveBase: async () => {
        retrieveCalls += 1;
        return {
          chunks: [buildChunk({ chunkId: "single-1" })],
          trace: buildTrace("find the policy"),
        };
      },
      generateVariations: async () => {
        generateVariationCalls += 1;
        return ["Find the policy", "policy requirements"];
      },
      generateHyde: async () => {
        generateHydeCalls += 1;
        return "hypothetical";
      },
    },
  );

  assert.equal(retrieveCalls, 1);
  assert.equal(generateVariationCalls, 0);
  assert.equal(generateHydeCalls, 0);
  assert.equal(result.queryExpansion.requested, true);
  assert.equal(result.queryExpansion.applied, false);
  assert.equal(result.queryExpansion.strategy, "standard");
});

test("retrieveRankedCandidatesWithRouting expands and fuses multi-document queries when requested", async () => {
  ensureRetrievalTestEnv();
  const { retrieveRankedCandidatesWithRouting } = await import("../lib/retrieval/router");

  const seenQueries: string[] = [];
  let rerankCallCount = 0;

  const result = await retrieveRankedCandidatesWithRouting(
    {
      query: "Compare the onboarding and security guidance",
      topK: 2,
      documentIds: ["doc-b", "doc-a"],
      enableQueryExpansion: true,
      cacheNamespace: "user:test::docs:doc-a,doc-b",
    },
    {
      generateVariations: async () => [
        "Compare the onboarding and security guidance",
        "compare onboarding requirements with security guidance",
        "how do onboarding and security instructions differ",
      ],
      generateHyde: async () => "The documents compare onboarding requirements, security controls, and operational differences.",
      retrieveBase: async ({ query }) => {
        seenQueries.push(query);
        if (query === "Compare the onboarding and security guidance") {
          return {
            chunks: [
              buildChunk({ chunkId: "base-a", retrievalScore: 0.9, documentId: "doc-a" }),
              buildChunk({ chunkId: "shared", retrievalScore: 0.8, documentId: "doc-b" }),
            ],
            trace: buildTrace("compare the onboarding and security guidance", { vector: 3, keyword: 2 }),
          };
        }
        if (query === "compare onboarding requirements with security guidance") {
          return {
            chunks: [
              buildChunk({ chunkId: "shared", retrievalScore: 0.88, documentId: "doc-b" }),
              buildChunk({ chunkId: "variation-b", retrievalScore: 0.76, documentId: "doc-b" }),
            ],
            trace: buildTrace("compare onboarding requirements with security guidance", { vector: 2, keyword: 1 }),
          };
        }
        if (query === "how do onboarding and security instructions differ") {
          return {
            chunks: [
              buildChunk({ chunkId: "variation-c", retrievalScore: 0.79, documentId: "doc-a" }),
            ],
            trace: buildTrace("how do onboarding and security instructions differ", { vector: 2, keyword: 0 }),
          };
        }
        return {
          chunks: [
            buildChunk({ chunkId: "hyde-d", retrievalScore: 0.7, documentId: "doc-b" }),
          ],
          trace: buildTrace("hyde", { vector: 1, keyword: 0 }),
        };
      },
      rerankCandidates: async ({ candidates, topK }) => {
        rerankCallCount += 1;
        assert.equal(candidates.some((chunk) => chunk.chunkId === "shared"), true);
        assert.equal(candidates.some((chunk) => chunk.chunkId === "hyde-d"), true);
        return candidates.slice(0, topK);
      },
    },
  );

  assert.deepEqual(seenQueries, [
    "Compare the onboarding and security guidance",
    "compare onboarding requirements with security guidance",
    "how do onboarding and security instructions differ",
    "The documents compare onboarding requirements, security controls, and operational differences.",
  ]);
  assert.equal(rerankCallCount, 1);
  assert.equal(result.queryExpansion.applied, true);
  assert.equal(result.queryExpansion.strategy, "multi_document_expansion");
  assert.equal(result.queryExpansion.variationCount, 2);
  assert.equal(result.queryExpansion.hydeUsed, true);
  assert.equal(result.queryExpansion.branchCount, 4);
  assert.equal(result.trace.candidateCounts.vector, 8);
  assert.equal(result.trace.candidateCounts.keyword, 3);
  assert.equal(result.chunks.length, 2);
});
