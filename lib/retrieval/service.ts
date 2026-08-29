import { startActiveObservation } from "@langfuse/tracing";
import type {
  RetrievedChunk,
  RetrievalTrace,
  SupportedLanguage,
} from "@/lib/contracts/retrieval";
import { env } from "@/lib/config/env";
import { summarizeChunks } from "@/lib/observability/trace-payloads";
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
import {
  buildRetrievalCacheKey,
  computeRetrievalConfigFingerprint,
} from "@/lib/retrieval/trace";
import { crossEncoderRerank } from "@/lib/retrieval/cross-encoder";
import { applyDocumentDiversity } from "@/lib/retrieval/diversity";
import { isDocumentOverviewQuery } from "@/lib/retrieval/intent";

const MIN_CANDIDATE_LIMIT = 20;

// Computed once: the ranking configuration is process-wide and immutable.
export const RETRIEVAL_CONFIG_FINGERPRINT = computeRetrievalConfigFingerprint({
  crossEncoderEnabled: env.RAG_CROSS_ENCODER_ENABLED,
  crossEncoderModel: env.RAG_CROSS_ENCODER_MODEL,
  rerankPoolSize: env.RAG_RERANK_POOL_SIZE,
  rrfK: env.RAG_RRF_K,
  maxChunksPerDocument: env.RAG_MAX_CHUNKS_PER_DOCUMENT,
  diversityRelevanceFloor: env.RAG_DIVERSITY_RELEVANCE_FLOOR,
  queryEmbeddingModel: env.RAG_QUERY_EMBEDDING_MODEL,
  queryEmbeddingDimensions: env.RAG_QUERY_EMBEDDING_DIMENSIONS,
});

export type RetrieveRankedCandidatesInput = {
  query: string;
  topK: number;
  languageHint?: SupportedLanguage;
  documentIds?: string[];
  cacheNamespace?: string;
};

export type RetrieveRankedCandidatesResult = {
  chunks: RetrievedChunk[];
  trace: RetrievalTrace;
};

export type RerankCandidatesFn = (input: {
  normalizedQuery: string;
  candidates: RetrievedChunk[];
  poolSize: number;
  language?: SupportedLanguage;
}) => Promise<RetrievedChunk[]>;

export type RetrievalServiceDependencies = {
  readCache: (input: ReadRetrievalCacheInput) => Promise<{
    chunks: RetrievedChunk[];
    candidateCounts: RetrievalTrace["candidateCounts"];
  } | null>;
  writeCache: (input: WriteRetrievalCacheInput) => Promise<void>;
  pruneCache: (currentRetrievalVersion: number) => Promise<void>;
  createEmbedding: (normalizedQuery: string) => Promise<number[]>;
  rerankCandidates: RerankCandidatesFn;
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

/**
 * The ranking chain every candidate pool goes through, whether it came from
 * a single hybrid search or from the router's fused expansion branches.
 *
 * Stage order matters: the heuristic reranker scores the whole pool, the
 * cross-encoder then re-orders that FULL pool (not the final topK, which would
 * make it incapable of rescuing a relevant candidate from deeper in the pool),
 * and document diversity re-balances the window. The caller slices to topK.
 */
export async function rankCandidatePool(input: {
  normalizedQuery: string;
  candidates: RetrievedChunk[];
  topK: number;
  language: SupportedLanguage;
  rerankCandidates: RerankCandidatesFn;
}): Promise<RetrievedChunk[]> {
  let ordered = await input.rerankCandidates({
    normalizedQuery: input.normalizedQuery,
    candidates: input.candidates,
    poolSize: env.RAG_RERANK_POOL_SIZE,
    language: input.language,
  });

  if (env.RAG_CROSS_ENCODER_ENABLED) {
    try {
      ordered = await crossEncoderRerank({
        query: input.normalizedQuery,
        chunks: ordered,
        model: env.RAG_CROSS_ENCODER_MODEL,
      });
    } catch {
      // Fall back to the heuristic order if the cross-encoder fails.
    }
  }

  if (env.RAG_MAX_CHUNKS_PER_DOCUMENT > 0) {
    ordered = applyDocumentDiversity(ordered, {
      topK: input.topK,
      maxPerDocument: env.RAG_MAX_CHUNKS_PER_DOCUMENT,
      relevanceFloor: env.RAG_DIVERSITY_RELEVANCE_FLOOR,
    });
  }

  return ordered;
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
  return startActiveObservation(
    "retrieve-candidates",
    async (observation) => {
      observation.update({
        input: {
          query: input.query,
          topK: input.topK,
          languageHint: input.languageHint ?? null,
          documentIds: input.documentIds ?? null,
        },
      });

      const result = await retrieveRankedCandidatesUntraced(input, overrides);

      observation.update({
        output: summarizeChunks(result.chunks),
        // A cache hit skips every child stage, so an otherwise empty subtree
        // is expected rather than a sign of a broken pipeline.
        metadata: {
          cacheHit: result.trace.cacheHit,
          language: result.trace.language,
          candidateCounts: result.trace.candidateCounts,
          retrievalVersion: result.trace.retrievalVersion,
          configFingerprint: result.trace.configFingerprint,
        },
      });

      return result;
    },
    { asType: "span" },
  );
}

async function retrieveRankedCandidatesUntraced(
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
    configFingerprint: RETRIEVAL_CONFIG_FINGERPRINT,
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
        configFingerprint: RETRIEVAL_CONFIG_FINGERPRINT,
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
        configFingerprint: RETRIEVAL_CONFIG_FINGERPRINT,
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

  // Neither search is language-filtered: every search already covers the
  // whole corpus. Language is applied as a ranking signal during rerank.
  const primaryEmbedding = await deps.createEmbedding(normalizedQuery);

  const [vectorCandidates, keywordCandidates] = await Promise.all([
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

  const fusedCandidates = reciprocalRankFusion({
    vectorCandidates,
    keywordCandidates,
    rrfK: env.RAG_RRF_K,
  });

  const orderedCandidates = await rankCandidatePool({
    normalizedQuery,
    candidates: fusedCandidates,
    topK,
    language,
    rerankCandidates: deps.rerankCandidates,
  });

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
    configFingerprint: RETRIEVAL_CONFIG_FINGERPRINT,
    topK,
    candidateCounts,
  };

  return {
    chunks: rerankedCandidates,
    trace,
  };
}
