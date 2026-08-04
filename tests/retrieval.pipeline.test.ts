import assert from "node:assert/strict";
import test from "node:test";
import type { RetrievedChunk } from "../lib/contracts/retrieval";
import type { RetrievalServiceDependencies } from "../lib/retrieval/service";
import { selectChunkIndexesMeetingThreshold } from "../lib/answering/policy";

function ensureRetrievalTestEnv(): void {
  process.env.SUPABASE_URL ??= "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY ??= "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-key";
  process.env.OPENAI_API_KEY ??= "test-openai-key";
  // Keep unit tests hermetic: the citation verifier would otherwise attempt a
  // real OpenAI call after answer generation.
  process.env.RAG_CITATION_VERIFICATION_ENABLED ??= "false";
}

function buildChunk(overrides: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    chunkId: "chunk-1",
    documentId: "doc-1",
    pageNumber: 1,
    sectionTitle: "Overview",
    content: "solar financing options",
    context: "municipal loan terms",
    language: "EN",
    source: "vector",
    retrievalScore: 0.8,
    ...overrides,
  };
}

test("retrieveRankedCandidates slices to topK after the rerank stages, not inside the reranker", async () => {
  // The reranker returns its full scored pool so the cross-encoder and
  // contextual grouping can act on candidates beyond the final topK. The
  // service is responsible for the final cut.
  ensureRetrievalTestEnv();
  const { retrieveRankedCandidates } = await import("../lib/retrieval/service");

  // Distinct documents so contextual grouping applies no adjacency boost and
  // the assertion isolates the topK slice behaviour.
  const pool = Array.from({ length: 6 }, (_, index) =>
    buildChunk({
      chunkId: `pool-${index}`,
      documentId: `doc-${index}`,
      retrievalScore: 0.9 - index * 0.1,
    }),
  );

  let rerankInputSize = 0;
  const deps: Partial<RetrievalServiceDependencies> = {
    pruneCache: async () => undefined,
    readCache: async () => null,
    writeCache: async () => undefined,
    createEmbedding: async () => [0.1, 0.2, 0.3],
    searchVector: async () => pool,
    searchKeyword: async () => [],
    rerankCandidates: async ({ candidates }) => {
      rerankInputSize = candidates.length;
      // Like the real reranker, emit an ordering score for every pool member
      // (contextual grouping perturbs rerankScore downstream).
      return candidates.map((candidate) => ({
        ...candidate,
        rerankScore: candidate.retrievalScore,
        relevanceScore: candidate.retrievalScore,
        scoreScale: "heuristic" as const,
      }));
    },
  };

  const result = await retrieveRankedCandidates(
    {
      query: "solar financing for municipalities",
      topK: 2,
      languageHint: "EN",
    },
    deps,
  );

  assert.equal(rerankInputSize, 6, "reranker should see the full fused pool");
  assert.equal(result.chunks.length, 2, "final result must be cut to topK");
  assert.equal(result.trace.candidateCounts.reranked, 2);
  assert.equal(result.chunks[0]?.chunkId, "pool-0");
});

test("crossEncoderRerank returns the full pool unchanged when no Cohere key is configured", async () => {
  ensureRetrievalTestEnv();
  delete process.env.COHERE_API_KEY;
  const { crossEncoderRerank } = await import("../lib/retrieval/cross-encoder");

  const pool = Array.from({ length: 5 }, (_, index) =>
    buildChunk({ chunkId: `ce-${index}` }),
  );

  const result = await crossEncoderRerank({
    query: "solar financing",
    chunks: pool,
    model: "rerank-v3.5",
  });

  // No key: pass through without truncation so the heuristic order and the
  // downstream topK slice stay in effect.
  assert.equal(result.length, 5);
  assert.deepEqual(
    result.map((chunk) => chunk.chunkId),
    pool.map((chunk) => chunk.chunkId),
  );
});

test("selectChunkIndexesMeetingThreshold keeps only chunks at or above their scale threshold", () => {
  const chunks = [
    buildChunk({
      chunkId: "strong",
      relevanceScore: 0.4,
      scoreScale: "heuristic",
    }),
    buildChunk({
      chunkId: "weak",
      relevanceScore: 0.05,
      scoreScale: "heuristic",
    }),
    buildChunk({
      chunkId: "strong-ce",
      relevanceScore: 0.3,
      scoreScale: "cross_encoder",
    }),
    buildChunk({
      chunkId: "weak-ce",
      relevanceScore: 0.2,
      scoreScale: "cross_encoder",
    }),
  ];

  const kept = selectChunkIndexesMeetingThreshold({
    chunks,
    minEvidenceChunks: 2,
    minRerankScore: 0.25,
    minHeuristicRelevance: 0.14,
  });

  assert.deepEqual(kept, [0, 2]);
});

test("generateWebAugmentedAnswer abstains when local evidence and web sources are both thin", async () => {
  ensureRetrievalTestEnv();
  const { generateWebAugmentedAnswer } =
    await import("../lib/answering/service");

  const result = await generateWebAugmentedAnswer(
    {
      query: "What is the refund policy?",
      language: "EN",
      chunks: [
        buildChunk({
          chunkId: "weak",
          relevanceScore: 0.02,
          scoreScale: "heuristic",
        }),
      ],
      minEvidenceChunks: 2,
      minRerankScore: 0.25,
      minHeuristicRelevance: 0.14,
      maxOutputTokens: 128,
      webSources: [
        {
          title: "Some page",
          url: "https://example.com/a",
          snippet: "a snippet",
          relevanceScore: 0.9,
        },
      ],
      minWebSources: 2,
    },
    {
      llmProvider: {
        generateAnswer: async () => {
          throw new Error("LLM must not be called when the gate abstains");
        },
      },
    },
  );

  assert.equal(result.insufficientEvidence, true);
});

test("generateWebAugmentedAnswer drops sub-threshold local chunks when proceeding on web evidence", async () => {
  ensureRetrievalTestEnv();
  const { generateWebAugmentedAnswer } =
    await import("../lib/answering/service");

  let capturedPrompt = "";
  const result = await generateWebAugmentedAnswer(
    {
      query: "What is the refund policy?",
      language: "EN",
      chunks: [
        buildChunk({
          chunkId: "weak",
          content: "UNRELATED-WEAK-CHUNK-TEXT",
          relevanceScore: 0.02,
          scoreScale: "heuristic",
        }),
        buildChunk({
          chunkId: "passing",
          content: "REFUND-POLICY-CHUNK-TEXT",
          relevanceScore: 0.2,
          scoreScale: "heuristic",
        }),
      ],
      // Three chunks required but only two retrieved: the local gate fails on
      // count, so the answer proceeds on web evidence with per-chunk filtering.
      minEvidenceChunks: 3,
      minRerankScore: 0.25,
      minHeuristicRelevance: 0.14,
      maxOutputTokens: 128,
      webSources: [
        {
          title: "Refund policy",
          url: "https://example.com/a",
          snippet: "refunds within 30 days",
          relevanceScore: 0.9,
        },
        {
          title: "Refund policy details",
          url: "https://example.com/b",
          snippet: "keep your receipt",
          relevanceScore: 0.8,
        },
      ],
      minWebSources: 2,
    },
    {
      llmProvider: {
        generateAnswer: async ({ userPrompt }) => {
          capturedPrompt = userPrompt;
          return "Refunds are honoured within 30 days [1].";
        },
      },
    },
  );

  assert.equal(result.insufficientEvidence, false);
  assert.ok(
    capturedPrompt.includes("REFUND-POLICY-CHUNK-TEXT"),
    "chunk meeting its threshold must stay in the prompt",
  );
  assert.ok(
    !capturedPrompt.includes("UNRELATED-WEAK-CHUNK-TEXT"),
    "sub-threshold chunk must be dropped from the prompt",
  );
  // [1] must resolve to the surviving chunk, not the dropped one.
  assert.equal(result.citations[0]?.chunkId, "passing");
});

test("EmbeddingProvider refuses to run without an API key instead of writing fake vectors", async () => {
  const { EmbeddingProvider } =
    await import("../lib/ingestion/runtime/embedding-provider");
  const { resolveIngestionRuntimeSettings } =
    await import("../lib/ingestion/runtime/types");

  const provider = new EmbeddingProvider(
    resolveIngestionRuntimeSettings({ openAiApiKey: null }),
    { info: () => undefined, warn: () => undefined, error: () => undefined },
  );

  await assert.rejects(
    provider.embedTexts(["some chunk text"]),
    /OPENAI_API_KEY is not configured/,
  );
});
