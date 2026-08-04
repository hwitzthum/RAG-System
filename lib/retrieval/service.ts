import type {
  RetrievedChunk,
  RetrievalTrace,
  SupportedLanguage,
} from "@/lib/contracts/retrieval";
import { env } from "@/lib/config/env";
import { getDefaultProviders } from "@/lib/providers/defaults";
import {
  pruneRetrievalCache,
  readRetrievalCache,
  type ReadRetrievalCacheInput,
  type WriteRetrievalCacheInput,
  writeRetrievalCache,
} from "@/lib/retrieval/cache";
import { detectQueryLanguage } from "@/lib/retrieval/language";
import { extractQueryTokens, normalizeQuery } from "@/lib/retrieval/query";
import { reciprocalRankFusion } from "@/lib/retrieval/rrf";
import {
  loadDocumentOverviewCandidates,
  searchKeywordCandidates,
  searchVectorCandidates,
} from "@/lib/retrieval/repository";
import { buildRetrievalCacheKey } from "@/lib/retrieval/trace";
import { crossEncoderRerank } from "@/lib/retrieval/cross-encoder";
import { applyContextualGrouping } from "@/lib/retrieval/contextual-grouping";
import { generateQueryVariations } from "@/lib/retrieval/multi-query";
import { isDocumentOverviewQuery } from "@/lib/retrieval/intent";

const MIN_CANDIDATE_LIMIT = 20;

export type RetrieveRankedCandidatesInput = {
  query: string;
  topK: number;
  languageHint?: SupportedLanguage;
  documentIds?: string[];
  cacheNamespace?: string;
  /**
   * Set by the router when this call is already one branch of an expanded
   * query. Without it the router's variations would each be expanded again
   * here, costing branches x variations embedding calls per request.
   */
  disableMultiQuery?: boolean;
};

export type RetrieveRankedCandidatesResult = {
  chunks: RetrievedChunk[];
  trace: RetrievalTrace;
};

export type RetrievalServiceDependencies = {
  readCache: (input: ReadRetrievalCacheInput) => Promise<{
    chunks: RetrievedChunk[];
    candidateCounts: RetrievalTrace["candidateCounts"];
  } | null>;
  writeCache: (input: WriteRetrievalCacheInput) => Promise<void>;
  pruneCache: (currentRetrievalVersion: number) => Promise<void>;
  createEmbedding: (normalizedQuery: string) => Promise<number[]>;
  rerankCandidates: (input: {
    normalizedQuery: string;
    candidates: RetrievedChunk[];
    poolSize: number;
    language?: SupportedLanguage;
  }) => Promise<RetrievedChunk[]>;
  searchVector: typeof searchVectorCandidates;
  searchKeyword: typeof searchKeywordCandidates;
  loadDocumentOverview: typeof loadDocumentOverviewCandidates;
};

function getDefaultDependencies(): RetrievalServiceDependencies {
  const providers = getDefaultProviders();
  return {
    readCache: readRetrievalCache,
    writeCache: writeRetrievalCache,
    pruneCache: pruneRetrievalCache,
    createEmbedding: providers.embedding.createEmbedding,
    rerankCandidates: providers.reranker.rerank,
    searchVector: searchVectorCandidates,
    searchKeyword: searchKeywordCandidates,
    loadDocumentOverview: loadDocumentOverviewCandidates,
  };
}

function normalizeDocumentScope(documentIds: string[] | undefined): string[] {
  if (!documentIds || documentIds.length === 0) {
    return [];
  }

  const uniqueIds = new Set(
    documentIds.map((item) => item.trim()).filter((item) => item.length > 0),
  );

  return [...uniqueIds].sort();
}

export async function retrieveRankedCandidates(
  input: RetrieveRankedCandidatesInput,
  overrides: Partial<RetrievalServiceDependencies> = {},
): Promise<RetrieveRankedCandidatesResult> {
  const deps = { ...getDefaultDependencies(), ...overrides };
  const normalizedQuery = normalizeQuery(input.query);
  if (!normalizedQuery) {
    throw new Error("Normalized query cannot be empty");
  }

  const language = detectQueryLanguage(normalizedQuery, input.languageHint);
  const topK = Math.max(1, input.topK);
  const retrievalVersion = env.RAG_RETRIEVAL_VERSION;
  const scopedDocumentIds = normalizeDocumentScope(input.documentIds);
  const documentOverviewQuery = isDocumentOverviewQuery(
    normalizedQuery,
    scopedDocumentIds,
  );
  const scopeKey = input.cacheNamespace?.trim()
    ? input.cacheNamespace.trim()
    : scopedDocumentIds.length > 0
      ? `docs:${scopedDocumentIds.join(",")}`
      : "scope:all";
  const strategyScopeKey = documentOverviewQuery
    ? `overview-v2:${scopeKey}`
    : scopeKey;
  const cacheKey = buildRetrievalCacheKey({
    normalizedQuery,
    language,
    retrievalVersion,
    topK,
    scopeKey: strategyScopeKey,
  });

  // Best-effort, fire-and-forget cache hygiene — avoids blocking the query path.
  void deps.pruneCache(retrievalVersion).catch((error) => {
    console.warn(
      "retrieval_cache_prune_failed",
      error instanceof Error ? error.message : String(error),
    );
  });

  let cached: {
    chunks: RetrievedChunk[];
    candidateCounts: RetrievalTrace["candidateCounts"];
  } | null = null;
  try {
    cached = await deps.readCache({
      cacheKey,
      retrievalVersion,
      topK,
    });
  } catch (error) {
    console.warn(
      "retrieval_cache_read_failed",
      error instanceof Error ? error.message : String(error),
    );
    cached = null;
  }

  if (cached && cached.chunks.length > 0) {
    return {
      chunks: cached.chunks,
      trace: {
        normalizedQuery,
        language,
        cacheKey,
        cacheHit: true,
        retrievalVersion,
        topK,
        candidateCounts: cached.candidateCounts,
      },
    };
  }

  if (documentOverviewQuery) {
    const overviewCandidates = await deps.loadDocumentOverview({
      documentId: scopedDocumentIds[0]!,
      limit: Math.max(topK, env.RAG_MIN_EVIDENCE_CHUNKS, 6),
    });

    const candidateCounts: RetrievalTrace["candidateCounts"] = {
      vector: 0,
      keyword: 0,
      fused: overviewCandidates.length,
      reranked: overviewCandidates.length,
    };

    try {
      await deps.writeCache({
        cacheKey,
        normalizedQuery,
        language,
        retrievalVersion,
        topK,
        chunks: overviewCandidates,
        candidateCounts,
        ttlSeconds: env.RAG_CACHE_TTL_SECONDS,
      });
    } catch (error) {
      console.warn(
        "retrieval_cache_write_failed",
        error instanceof Error ? error.message : String(error),
      );
    }

    return {
      chunks: overviewCandidates,
      trace: {
        normalizedQuery,
        language,
        cacheKey,
        cacheHit: false,
        retrievalVersion,
        topK,
        candidateCounts,
      },
    };
  }

  const candidateLimit = Math.max(
    topK * 4,
    env.RAG_RERANK_POOL_SIZE,
    MIN_CANDIDATE_LIMIT,
  );
  const tokens = extractQueryTokens(normalizedQuery);

  let vectorCandidates: RetrievedChunk[];
  let keywordCandidates: RetrievedChunk[];

  // Neither search is language-filtered any more, so there is no
  // cross-language fallback pass to run: every search already covers the whole
  // corpus. Language is applied as a ranking signal during rerank instead.
  if (env.RAG_MULTI_QUERY_ENABLED && !input.disableMultiQuery) {
    const queries = await generateQueryVariations(normalizedQuery, language);
    const embeddings = await Promise.all(
      queries.map((q) => deps.createEmbedding(q)),
    );

    const vectorResults = await Promise.all(
      embeddings.map((emb) =>
        deps.searchVector({
          queryEmbedding: emb,
          limit: candidateLimit,
          documentIds: scopedDocumentIds,
        }),
      ),
    );

    // Merge vector results, keeping the best score per chunk
    const chunkMap = new Map<string, RetrievedChunk>();
    for (const results of vectorResults) {
      for (const chunk of results) {
        const existing = chunkMap.get(chunk.chunkId);
        if (!existing || chunk.retrievalScore > existing.retrievalScore) {
          chunkMap.set(chunk.chunkId, chunk);
        }
      }
    }
    vectorCandidates = [...chunkMap.values()];

    keywordCandidates = await deps.searchKeyword({
      normalizedQuery,
      tokens,
      limit: candidateLimit,
      documentIds: scopedDocumentIds,
    });
  } else {
    const primaryEmbedding = await deps.createEmbedding(normalizedQuery);

    const [vc, kc] = await Promise.all([
      deps.searchVector({
        queryEmbedding: primaryEmbedding,
        limit: candidateLimit,
        documentIds: scopedDocumentIds,
      }),
      deps.searchKeyword({
        normalizedQuery,
        tokens,
        limit: candidateLimit,
        documentIds: scopedDocumentIds,
      }),
    ]);
    vectorCandidates = vc;
    keywordCandidates = kc;
  }

  const fusedCandidates = reciprocalRankFusion({
    vectorCandidates,
    keywordCandidates,
    rrfK: env.RAG_RRF_K,
  });

  // Stage order matters: the heuristic reranker scores the whole fused pool,
  // the cross-encoder then re-orders that FULL pool (not the final topK, which
  // would make it incapable of rescuing a relevant candidate from deeper in
  // the pool), contextual grouping applies its adjacency boost while
  // borderline chunks are still in play, and only then is the list cut to topK.
  let orderedCandidates = await deps.rerankCandidates({
    normalizedQuery,
    candidates: fusedCandidates,
    poolSize: env.RAG_RERANK_POOL_SIZE,
    language,
  });

  if (env.RAG_CROSS_ENCODER_ENABLED) {
    try {
      orderedCandidates = await crossEncoderRerank({
        query: normalizedQuery,
        chunks: orderedCandidates,
        model: env.RAG_CROSS_ENCODER_MODEL,
      });
    } catch {
      // Fall back to existing rerank order if cross-encoder fails.
    }
  }

  if (env.RAG_CONTEXTUAL_GROUPING_ENABLED) {
    orderedCandidates = applyContextualGrouping(orderedCandidates);
  }

  const rerankedCandidates = orderedCandidates.slice(0, topK);

  const candidateCounts: RetrievalTrace["candidateCounts"] = {
    vector: vectorCandidates.length,
    keyword: keywordCandidates.length,
    fused: fusedCandidates.length,
    reranked: rerankedCandidates.length,
  };

  try {
    await deps.writeCache({
      cacheKey,
      normalizedQuery,
      language,
      retrievalVersion,
      topK,
      chunks: rerankedCandidates,
      candidateCounts,
      ttlSeconds: env.RAG_CACHE_TTL_SECONDS,
    });
  } catch (error) {
    console.warn(
      "retrieval_cache_write_failed",
      error instanceof Error ? error.message : String(error),
    );
    // Continue response path if cache write fails.
  }

  const trace: RetrievalTrace = {
    normalizedQuery,
    language,
    cacheKey,
    cacheHit: false,
    retrievalVersion,
    topK,
    candidateCounts,
  };

  return {
    chunks: rerankedCandidates,
    trace,
  };
}
