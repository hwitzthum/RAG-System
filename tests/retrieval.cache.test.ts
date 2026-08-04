import assert from "node:assert/strict";
import test from "node:test";
import type {
  RetrievedChunk,
  RetrievalTrace,
} from "../lib/contracts/retrieval";
import type { RetrievalServiceDependencies } from "../lib/retrieval/service";

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
    content: "solar financing options",
    context: "municipal loan terms",
    language: "EN",
    source: "vector",
    retrievalScore: 0.8,
    ...overrides,
  };
}

test("retrieveRankedCandidates reads from cache before retrieval/rerank on repeated query", async () => {
  ensureRetrievalTestEnv();
  const { retrieveRankedCandidates } = await import("../lib/retrieval/service");

  const cacheStore = new Map<
    string,
    {
      chunks: RetrievedChunk[];
      candidateCounts: RetrievalTrace["candidateCounts"];
    }
  >();

  let pruneCalls = 0;
  let readCalls = 0;
  let writeCalls = 0;
  let embeddingCalls = 0;
  let vectorCalls = 0;
  let keywordCalls = 0;

  const deps: Partial<RetrievalServiceDependencies> = {
    pruneCache: async () => {
      pruneCalls += 1;
    },
    readCache: async ({ cacheKey, topK }) => {
      readCalls += 1;
      const found = cacheStore.get(cacheKey);
      if (!found) {
        return null;
      }

      return {
        chunks: found.chunks.slice(0, topK),
        candidateCounts: found.candidateCounts,
      };
    },
    writeCache: async (input) => {
      writeCalls += 1;
      cacheStore.set(input.cacheKey, {
        chunks: input.chunks,
        candidateCounts: input.candidateCounts,
      });
    },
    createEmbedding: async () => {
      embeddingCalls += 1;
      return [0.1, 0.2, 0.3];
    },
    searchVector: async () => {
      vectorCalls += 1;
      return [
        buildChunk({
          chunkId: "vector-a",
          source: "vector",
          retrievalScore: 0.91,
        }),
      ];
    },
    searchKeyword: async () => {
      keywordCalls += 1;
      return [
        buildChunk({
          chunkId: "vector-a",
          source: "keyword",
          retrievalScore: 0.72,
        }),
      ];
    },
  };

  const first = await retrieveRankedCandidates(
    {
      query: "Solar financing",
      topK: 1,
      languageHint: "EN",
    },
    deps,
  );

  const second = await retrieveRankedCandidates(
    {
      query: "Solar financing",
      topK: 1,
      languageHint: "EN",
    },
    deps,
  );

  assert.equal(first.trace.cacheHit, false);
  assert.equal(second.trace.cacheHit, true);
  assert.equal(first.chunks.length, 1);
  assert.equal(second.chunks.length, 1);
  assert.equal(second.chunks[0]?.chunkId, first.chunks[0]?.chunkId);

  assert.equal(pruneCalls, 2);
  assert.equal(readCalls, 2);
  assert.equal(writeCalls, 1);
  assert.equal(embeddingCalls, 1);
  assert.equal(vectorCalls, 1);
  assert.equal(keywordCalls, 1);
});

test("retrieveRankedCandidates never language-filters the searches", async () => {
  // Replaces two former "falls back to cross-language retrieval" tests. There
  // is no fallback pass any more because there is nothing to fall back from:
  // both searches always cover the whole corpus. text-embedding-3-large is
  // multilingual, so filtering by a heuristically detected query language
  // discarded recall for no gain.
  ensureRetrievalTestEnv();
  const { retrieveRankedCandidates } = await import("../lib/retrieval/service");

  const vectorLanguages: Array<string | null | undefined> = [];
  const keywordLanguages: Array<string | null | undefined> = [];

  const deps: Partial<RetrievalServiceDependencies> = {
    pruneCache: async () => undefined,
    readCache: async () => null,
    writeCache: async () => undefined,
    createEmbedding: async () => [0.1, 0.2, 0.3],
    searchVector: async ({ language }) => {
      vectorLanguages.push(language);
      return [
        buildChunk({
          chunkId: "de-chunk-1",
          documentId: "doc-de-1",
          language: "DE",
          retrievalScore: 0.83,
          source: "vector",
        }),
      ];
    },
    searchKeyword: async ({ language }) => {
      keywordLanguages.push(language);
      return [];
    },
    rerankCandidates: async ({ candidates }) => candidates,
  };

  const result = await retrieveRankedCandidates(
    {
      query: "What is the focus point of this document?",
      topK: 3,
      languageHint: "EN",
    },
    deps,
  );

  assert.equal(result.trace.cacheHit, false);
  // A German chunk is reachable from a query detected as English, in a single
  // pass rather than only via a conditional second round trip.
  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0]?.documentId, "doc-de-1");
  assert.equal(
    vectorLanguages.length,
    1,
    "vector search should run exactly once",
  );
  assert.equal(
    keywordLanguages.length,
    1,
    "keyword search should run exactly once",
  );
  assert.equal(vectorLanguages[0], undefined);
  assert.equal(keywordLanguages[0], undefined);
});

test("retrieveRankedCandidates passes the detected language to the reranker", async () => {
  // Language survives as a ranking signal even though it no longer filters.
  ensureRetrievalTestEnv();
  const { retrieveRankedCandidates } = await import("../lib/retrieval/service");

  const rerankLanguages: Array<string | undefined> = [];

  await retrieveRankedCandidates(
    {
      query: "Wie lautet der Sentinel-Wert?",
      topK: 3,
      languageHint: "DE",
    },
    {
      pruneCache: async () => undefined,
      readCache: async () => null,
      writeCache: async () => undefined,
      createEmbedding: async () => [0.1, 0.2, 0.3],
      searchVector: async () => [
        buildChunk({
          chunkId: "de-vec-1",
          documentId: "doc-de",
          language: "DE",
          retrievalScore: 0.85,
          source: "vector",
        }),
      ],
      searchKeyword: async () => [],
      rerankCandidates: async ({ candidates, language }) => {
        rerankLanguages.push(language);
        return candidates;
      },
    },
  );

  assert.deepEqual(rerankLanguages, ["DE"]);
});

test("retrieveRankedCandidates forwards document scope to vector and keyword retrieval", async () => {
  ensureRetrievalTestEnv();
  const { retrieveRankedCandidates } = await import("../lib/retrieval/service");

  const vectorDocumentScopes: string[][] = [];
  const keywordDocumentScopes: string[][] = [];

  const deps: Partial<RetrievalServiceDependencies> = {
    pruneCache: async () => undefined,
    readCache: async () => null,
    writeCache: async () => undefined,
    createEmbedding: async () => [0.1, 0.2, 0.3],
    searchVector: async ({ documentIds }) => {
      vectorDocumentScopes.push(documentIds ?? []);
      return [
        buildChunk({
          chunkId: "scope-vector-1",
          documentId: "doc-scope-1",
          source: "vector",
          retrievalScore: 0.84,
        }),
      ];
    },
    searchKeyword: async ({ documentIds }) => {
      keywordDocumentScopes.push(documentIds ?? []);
      return [];
    },
    rerankCandidates: async ({ candidates }) => candidates,
  };

  const result = await retrieveRankedCandidates(
    {
      query: "What is this document about?",
      topK: 3,
      languageHint: "EN",
      documentIds: ["doc-scope-2", "doc-scope-1", "doc-scope-2"],
    },
    deps,
  );

  assert.equal(result.trace.cacheHit, false);
  assert.equal(result.chunks.length, 1);
  assert.deepEqual(vectorDocumentScopes, [["doc-scope-1", "doc-scope-2"]]);
  assert.deepEqual(keywordDocumentScopes, [["doc-scope-1", "doc-scope-2"]]);
});

test("retrieveRankedCandidates uses overview retrieval for generic single-document summary queries", async () => {
  ensureRetrievalTestEnv();
  const { retrieveRankedCandidates } = await import("../lib/retrieval/service");

  let overviewCalls = 0;
  let vectorCalls = 0;
  let keywordCalls = 0;

  const deps: Partial<RetrievalServiceDependencies> = {
    pruneCache: async () => undefined,
    readCache: async () => null,
    writeCache: async () => undefined,
    createEmbedding: async () => {
      throw new Error(
        "Embedding retrieval should not run for overview queries",
      );
    },
    searchVector: async () => {
      vectorCalls += 1;
      return [];
    },
    searchKeyword: async () => {
      keywordCalls += 1;
      return [];
    },
    loadDocumentOverview: async ({ documentId, limit }) => {
      overviewCalls += 1;
      assert.equal(documentId, "doc-scope-1");
      assert.equal(limit >= 6, true);
      return [
        buildChunk({
          chunkId: "overview-1",
          documentId: "doc-scope-1",
          source: "hybrid",
          retrievalScore: 1,
          content:
            "This handbook explains the operating checklist and process overview.",
        }),
        buildChunk({
          chunkId: "overview-2",
          documentId: "doc-scope-1",
          source: "hybrid",
          retrievalScore: 0.99,
          content:
            "It covers responsibilities, controls, and documentation requirements.",
        }),
      ];
    },
  };

  const result = await retrieveRankedCandidates(
    {
      query: "Please summarize the document for me",
      topK: 3,
      languageHint: "EN",
      documentIds: ["doc-scope-1"],
    },
    deps,
  );

  assert.equal(result.trace.cacheHit, false);
  assert.equal(result.chunks.length, 2);
  assert.equal(result.trace.candidateCounts.vector, 0);
  assert.equal(result.trace.candidateCounts.keyword, 0);
  assert.equal(overviewCalls, 1);
  assert.equal(vectorCalls, 0);
  assert.equal(keywordCalls, 0);
});

test("retrieveRankedCandidates keeps standard retrieval for specific single-document questions", async () => {
  ensureRetrievalTestEnv();
  const { retrieveRankedCandidates } = await import("../lib/retrieval/service");

  let overviewCalls = 0;
  let vectorCalls = 0;
  let keywordCalls = 0;

  const deps: Partial<RetrievalServiceDependencies> = {
    pruneCache: async () => undefined,
    readCache: async () => null,
    writeCache: async () => undefined,
    createEmbedding: async () => [0.1, 0.2, 0.3],
    searchVector: async () => {
      vectorCalls += 1;
      return [
        buildChunk({
          chunkId: "specific-1",
          documentId: "doc-scope-1",
          source: "vector",
          retrievalScore: 0.88,
          content: "Section 4 defines the approval workflow.",
        }),
      ];
    },
    searchKeyword: async () => {
      keywordCalls += 1;
      return [];
    },
    loadDocumentOverview: async () => {
      overviewCalls += 1;
      return [];
    },
    rerankCandidates: async ({ candidates }) => candidates,
  };

  const result = await retrieveRankedCandidates(
    {
      query: "What does the document say about the approval workflow?",
      topK: 3,
      languageHint: "EN",
      documentIds: ["doc-scope-1"],
    },
    deps,
  );

  assert.equal(result.trace.cacheHit, false);
  assert.equal(result.chunks[0]?.chunkId, "specific-1");
  assert.equal(overviewCalls, 0);
  assert.equal(vectorCalls > 0, true);
  assert.equal(keywordCalls > 0, true);
});
