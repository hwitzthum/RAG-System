import assert from "node:assert/strict";
import test from "node:test";
import type {
  RetrievedChunk,
  RetrievalTrace,
} from "../lib/contracts/retrieval";

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

function buildTrace(
  normalizedQuery: string,
  candidateCounts?: Partial<RetrievalTrace["candidateCounts"]>,
): RetrievalTrace {
  return {
    normalizedQuery,
    language: "EN",
    cacheKey: `cache:${normalizedQuery}`,
    cacheHit: false,
    retrievalVersion: 1,
    configFingerprint: "cfg000000000",
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
  const { retrieveRankedCandidatesWithRouting } =
    await import("../lib/retrieval/router");

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
    branchCount: 1,
  });
});

test("retrieveRankedCandidatesWithRouting expands a single-document scope when requested", async () => {
  // Expansion is a per-request opt-in and no longer requires 2+ scoped
  // documents; a single-document (or unscoped) query still fans out into
  // base + variation branches.
  ensureRetrievalTestEnv();
  const { retrieveRankedCandidatesWithRouting } =
    await import("../lib/retrieval/router");

  let retrieveCalls = 0;
  let generateVariationCalls = 0;

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
    },
  );

  // base + one surviving variation ("Find the policy" collapses into the
  // base query and is filtered).
  assert.equal(retrieveCalls, 2);
  assert.equal(generateVariationCalls, 1);
  assert.equal(result.queryExpansion.requested, true);
  assert.equal(result.queryExpansion.applied, true);
  assert.equal(result.queryExpansion.strategy, "query_expansion");
});

test("retrieveRankedCandidatesWithRouting expands and fuses multi-document queries when requested", async () => {
  ensureRetrievalTestEnv();
  const { retrieveRankedCandidatesWithRouting } =
    await import("../lib/retrieval/router");

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
      retrieveBase: async ({ query }) => {
        seenQueries.push(query);
        if (query === "Compare the onboarding and security guidance") {
          return {
            chunks: [
              buildChunk({
                chunkId: "base-a",
                retrievalScore: 0.9,
                documentId: "doc-a",
              }),
              buildChunk({
                chunkId: "shared",
                retrievalScore: 0.8,
                documentId: "doc-b",
              }),
            ],
            trace: buildTrace("compare the onboarding and security guidance", {
              vector: 3,
              keyword: 2,
            }),
          };
        }
        if (
          query === "compare onboarding requirements with security guidance"
        ) {
          return {
            chunks: [
              buildChunk({
                chunkId: "shared",
                retrievalScore: 0.88,
                documentId: "doc-b",
              }),
              buildChunk({
                chunkId: "variation-b",
                retrievalScore: 0.76,
                documentId: "doc-b",
              }),
            ],
            trace: buildTrace(
              "compare onboarding requirements with security guidance",
              { vector: 2, keyword: 1 },
            ),
          };
        }
        if (query === "how do onboarding and security instructions differ") {
          return {
            chunks: [
              buildChunk({
                chunkId: "variation-c",
                retrievalScore: 0.79,
                documentId: "doc-a",
              }),
            ],
            trace: buildTrace(
              "how do onboarding and security instructions differ",
              { vector: 2, keyword: 0 },
            ),
          };
        }
        throw new Error(`unexpected branch query: ${query}`);
      },
      rerankCandidates: async ({ candidates }) => {
        rerankCallCount += 1;
        assert.equal(
          candidates.some((chunk) => chunk.chunkId === "shared"),
          true,
        );
        return candidates;
      },
    },
  );

  assert.deepEqual(seenQueries, [
    "Compare the onboarding and security guidance",
    "compare onboarding requirements with security guidance",
    "how do onboarding and security instructions differ",
  ]);
  assert.equal(rerankCallCount, 1);
  assert.equal(result.queryExpansion.applied, true);
  assert.equal(result.queryExpansion.strategy, "query_expansion");
  assert.equal(result.queryExpansion.variationCount, 2);
  assert.equal(result.queryExpansion.branchCount, 3);
  assert.equal(result.trace.candidateCounts.vector, 7);
  assert.equal(result.trace.candidateCounts.keyword, 3);
  assert.equal(result.chunks.length, 2);
});

// ---- Query decomposition (Wave 5) ------------------------------------------

/**
 * The env module is loaded once per process, so per-test configuration
 * mutates the parsed config object and restores it afterwards.
 */
async function withEnv(
  overrides: Record<string, unknown>,
  fn: () => Promise<void>,
): Promise<void> {
  const { env } = await import("../lib/config/env");
  const mutable = env as unknown as Record<string, unknown>;
  const previous: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = mutable[key];
    mutable[key] = value;
  }
  try {
    await fn();
  } finally {
    Object.assign(mutable, previous);
  }
}

test("decomposition is never attempted when the flag is off", async () => {
  ensureRetrievalTestEnv();
  const { retrieveRankedCandidatesWithRouting } =
    await import("../lib/retrieval/router");

  let decomposeCalls = 0;
  const result = await retrieveRankedCandidatesWithRouting(
    { query: "What is covered?", topK: 3 },
    {
      retrieveBase: async () => ({
        chunks: [buildChunk({ chunkId: "base-1" })],
        trace: buildTrace("what is covered?"),
      }),
      decomposeQuery: async () => {
        decomposeCalls += 1;
        return ["Topic A", "Topic B"];
      },
    },
  );

  assert.equal(decomposeCalls, 0);
  assert.equal(result.chunks[0]?.chunkId, "base-1");
  assert.deepEqual(result.queryDecomposition, {
    requested: false,
    applied: false,
    subQueryCount: 0,
    subQueries: [],
  });
});

test("decomposition flag on with a single-topic query is a pure pass-through", async () => {
  ensureRetrievalTestEnv();
  const { retrieveRankedCandidatesWithRouting } =
    await import("../lib/retrieval/router");

  await withEnv({ RAG_QUERY_DECOMPOSITION_ENABLED: true }, async () => {
    let retrieveCalls = 0;
    const result = await retrieveRankedCandidatesWithRouting(
      { query: "What is covered?", topK: 3 },
      {
        retrieveBase: async () => {
          retrieveCalls += 1;
          return {
            chunks: [buildChunk({ chunkId: "base-1" })],
            trace: buildTrace("what is covered?"),
          };
        },
        decomposeQuery: async () => [],
      },
    );

    assert.equal(retrieveCalls, 1);
    assert.equal(result.chunks[0]?.chunkId, "base-1");
    assert.deepEqual(result.queryDecomposition, {
      requested: true,
      applied: false,
      subQueryCount: 0,
      subQueries: [],
    });
  });
});

test("decomposition fans out per sub-query and merges by weighted rank fusion", async () => {
  ensureRetrievalTestEnv();
  const { retrieveRankedCandidatesWithRouting } =
    await import("../lib/retrieval/router");

  await withEnv({ RAG_QUERY_DECOMPOSITION_ENABLED: true }, async () => {
    const seenInputs: Array<{
      query: string;
      languageHint?: string;
      cacheNamespace?: string;
    }> = [];

    const result = await retrieveRankedCandidatesWithRouting(
      {
        query: "How do AI perceptions relate to migrant support?",
        topK: 4,
        languageHint: "EN",
        cacheNamespace: "benchmark:test",
      },
      {
        retrieveBase: async (input) => {
          seenInputs.push({
            query: input.query,
            languageHint: input.languageHint,
            cacheNamespace: input.cacheNamespace,
          });
          if (input.query === "What are perceptions of AI in the workplace?") {
            return {
              chunks: [
                buildChunk({
                  chunkId: "golden-a",
                  documentId: "doc-a",
                  relevanceScore: 0.95,
                  rerankScore: 0.95,
                  scoreScale: "cross_encoder",
                }),
                // Same chunk as the base window but scored higher against the
                // focused sub-query: the merge must keep this entry.
                buildChunk({
                  chunkId: "shared",
                  documentId: "doc-a",
                  relevanceScore: 0.8,
                  rerankScore: 0.8,
                  scoreScale: "cross_encoder",
                }),
              ],
              trace: {
                ...buildTrace("sub-a"),
                cacheHit: true,
              },
            };
          }
          if (input.query === "What support is provided to migrants?") {
            return {
              chunks: [
                buildChunk({
                  chunkId: "golden-b",
                  documentId: "doc-b",
                  relevanceScore: 0.9,
                  rerankScore: 0.9,
                  scoreScale: "cross_encoder",
                }),
              ],
              trace: {
                ...buildTrace("sub-b"),
                cacheHit: true,
              },
            };
          }
          return {
            chunks: [
              buildChunk({
                chunkId: "base-top",
                documentId: "doc-a",
                relevanceScore: 0.7,
                rerankScore: 0.7,
                scoreScale: "cross_encoder",
              }),
              buildChunk({
                chunkId: "shared",
                documentId: "doc-a",
                relevanceScore: 0.4,
                rerankScore: 0.4,
                scoreScale: "cross_encoder",
              }),
            ],
            trace: buildTrace("base"),
          };
        },
        decomposeQuery: async () => [
          "What are perceptions of AI in the workplace?",
          "What support is provided to migrants?",
        ],
      },
    );

    assert.equal(seenInputs.length, 3);
    const subInputs = seenInputs.filter(
      (input) =>
        input.query !== "How do AI perceptions relate to migrant support?",
    );
    assert.equal(subInputs.length, 2);
    for (const input of subInputs) {
      assert.equal(input.languageHint, "EN");
      assert.equal(input.cacheNamespace, "benchmark:test::decomp");
    }

    // Weighted RRF order, not absolute relevance: "shared" appears in two
    // pools (base rank 2, sub-A rank 2) and its summed rank score outranks
    // every single-pool chunk despite lower absolute relevance — the
    // corroboration property. Base rank 1 outweighs the sub-pool tops
    // (weight 1 vs 0.9); the tied sub-pool tops keep insertion order.
    assert.deepEqual(
      result.chunks.map((chunk) => chunk.chunkId),
      ["shared", "base-top", "golden-a", "golden-b"],
    );
    // Absolute scores are rebuilt from the best-scoring pool: shared carries
    // its sub-A relevance (0.8), not its base-window copy (0.4).
    assert.equal(result.chunks[0]?.relevanceScore, 0.8);
    assert.ok(result.trace.cacheKey.endsWith("::decomposed"));
    // Base branch was uncached, so the conjunction reports uncached.
    assert.equal(result.trace.cacheHit, false);
    assert.deepEqual(result.queryDecomposition, {
      requested: true,
      applied: true,
      subQueryCount: 2,
      subQueries: [
        "What are perceptions of AI in the workplace?",
        "What support is provided to migrants?",
      ],
    });
  });
});

test("decomposition re-applies the per-document cap over the merged pool", async () => {
  ensureRetrievalTestEnv();
  const { retrieveRankedCandidatesWithRouting } =
    await import("../lib/retrieval/router");

  await withEnv(
    {
      RAG_QUERY_DECOMPOSITION_ENABLED: true,
      RAG_MAX_CHUNKS_PER_DOCUMENT: 2,
      RAG_DIVERSITY_RELEVANCE_FLOOR: 0.125,
    },
    async () => {
      const docAChunk = (id: string, relevance: number) =>
        buildChunk({
          chunkId: id,
          documentId: "doc-a",
          relevanceScore: relevance,
          rerankScore: relevance,
          scoreScale: "cross_encoder" as const,
        });

      const result = await retrieveRankedCandidatesWithRouting(
        {
          query: "How do AI perceptions relate to migrant support?",
          topK: 3,
          languageHint: "EN",
        },
        {
          retrieveBase: async (input) => {
            if (input.query === "Sub query one about topic A") {
              return {
                chunks: [docAChunk("a-3", 0.85), docAChunk("a-4", 0.82)],
                trace: buildTrace("sub-a"),
              };
            }
            if (input.query === "Sub query two about topic B") {
              return {
                chunks: [
                  buildChunk({
                    chunkId: "b-1",
                    documentId: "doc-b",
                    relevanceScore: 0.5,
                    rerankScore: 0.5,
                    scoreScale: "cross_encoder",
                  }),
                ],
                trace: buildTrace("sub-b"),
              };
            }
            return {
              chunks: [docAChunk("a-1", 0.9), docAChunk("a-2", 0.88)],
              trace: buildTrace("base"),
            };
          },
          decomposeQuery: async () => [
            "Sub query one about topic A",
            "Sub query two about topic B",
          ],
        },
      );

      // Without the re-applied cap the window would be a-1, a-2, a-3 (all
      // doc-a). The cap holds doc-a to 2 and promotes the qualifying doc-b
      // chunk into the final slot.
      assert.deepEqual(
        result.chunks.map((chunk) => chunk.chunkId),
        ["a-1", "a-2", "b-1"],
      );
    },
  );
});

test("decomposition is skipped for a single-document scope and on the expansion path", async () => {
  ensureRetrievalTestEnv();
  const { retrieveRankedCandidatesWithRouting } =
    await import("../lib/retrieval/router");

  await withEnv({ RAG_QUERY_DECOMPOSITION_ENABLED: true }, async () => {
    let decomposeCalls = 0;
    const decomposeQuery = async () => {
      decomposeCalls += 1;
      return ["Topic A", "Topic B"];
    };

    const singleDoc = await retrieveRankedCandidatesWithRouting(
      { query: "What is covered?", topK: 3, documentIds: ["doc-a"] },
      {
        retrieveBase: async () => ({
          chunks: [buildChunk({ chunkId: "base-1" })],
          trace: buildTrace("what is covered?"),
        }),
        decomposeQuery,
      },
    );
    assert.equal(decomposeCalls, 0);
    assert.deepEqual(singleDoc.queryDecomposition, {
      requested: false,
      applied: false,
      subQueryCount: 0,
      subQueries: [],
    });

    const expanded = await retrieveRankedCandidatesWithRouting(
      { query: "What is covered?", topK: 3, enableQueryExpansion: true },
      {
        retrieveBase: async (input) => ({
          chunks: [buildChunk({ chunkId: "base-1" })],
          trace: buildTrace(input.query),
        }),
        generateVariations: async () => [],
        rerankCandidates: async ({ candidates }) => candidates,
        decomposeQuery,
      },
    );
    assert.equal(decomposeCalls, 0);
    assert.deepEqual(expanded.queryDecomposition, {
      requested: false,
      applied: false,
      subQueryCount: 0,
      subQueries: [],
    });
  });
});

test("a rejecting decomposition dependency leaves the base result unharmed", async () => {
  ensureRetrievalTestEnv();
  const { retrieveRankedCandidatesWithRouting } =
    await import("../lib/retrieval/router");

  await withEnv({ RAG_QUERY_DECOMPOSITION_ENABLED: true }, async () => {
    const result = await retrieveRankedCandidatesWithRouting(
      { query: "What is covered?", topK: 3 },
      {
        retrieveBase: async () => ({
          chunks: [buildChunk({ chunkId: "base-1" })],
          trace: buildTrace("what is covered?"),
        }),
        decomposeQuery: async () => {
          throw new Error("provider unavailable");
        },
      },
    );

    assert.equal(result.chunks[0]?.chunkId, "base-1");
    assert.deepEqual(result.queryDecomposition, {
      requested: true,
      applied: false,
      subQueryCount: 0,
      subQueries: [],
    });
  });
});

test("a failed sub-query branch degrades to an empty pool instead of failing the request", async () => {
  ensureRetrievalTestEnv();
  const { retrieveRankedCandidatesWithRouting } =
    await import("../lib/retrieval/router");

  await withEnv({ RAG_QUERY_DECOMPOSITION_ENABLED: true }, async () => {
    const result = await retrieveRankedCandidatesWithRouting(
      {
        query: "How do AI perceptions relate to migrant support?",
        topK: 3,
        languageHint: "EN",
      },
      {
        retrieveBase: async (input) => {
          if (input.query === "Failing sub query") {
            throw new Error("supabase timeout");
          }
          if (input.query === "Working sub query") {
            return {
              chunks: [
                buildChunk({
                  chunkId: "sub-1",
                  documentId: "doc-b",
                  relevanceScore: 0.9,
                  rerankScore: 0.9,
                  scoreScale: "cross_encoder",
                }),
              ],
              trace: buildTrace("sub"),
            };
          }
          return {
            chunks: [
              buildChunk({
                chunkId: "base-1",
                relevanceScore: 0.7,
                rerankScore: 0.7,
                scoreScale: "cross_encoder",
              }),
            ],
            trace: buildTrace("base"),
          };
        },
        decomposeQuery: async () => ["Failing sub query", "Working sub query"],
      },
    );

    // RRF: the weight-1 base rank 1 outranks the weight-0.9 sub rank 1.
    assert.deepEqual(
      result.chunks.map((chunk) => chunk.chunkId),
      ["base-1", "sub-1"],
    );
    assert.equal(result.queryDecomposition.applied, true);
  });
});
