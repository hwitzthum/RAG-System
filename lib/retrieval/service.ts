import type { RetrievedChunk, RetrievalTrace, SupportedLanguage } from "@/lib/contracts/retrieval";
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
import { searchKeywordCandidates, searchVectorCandidates } from "@/lib/retrieval/repository";
import { buildRetrievalCacheKey } from "@/lib/retrieval/trace";

const MIN_CANDIDATE_LIMIT = 20;

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
    topK: number;
  }) => Promise<RetrievedChunk[]>;
  searchVector: typeof searchVectorCandidates;
  searchKeyword: typeof searchKeywordCandidates;
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
  };
}

function mergeUniqueChunks(primary: RetrievedChunk[], secondary: RetrievedChunk[]): RetrievedChunk[] {
  const seen = new Set<string>();
  const merged: RetrievedChunk[] = [];

  for (const chunk of primary.concat(secondary)) {
    if (seen.has(chunk.chunkId)) {
      continue;
    }
    seen.add(chunk.chunkId);
    merged.push(chunk);
  }

  return merged;
}

function normalizeDocumentScope(documentIds: string[] | undefined): string[] {
  if (!documentIds || documentIds.length === 0) {
    return [];
  }

  const uniqueIds = new Set(
    documentIds
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
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
  const scopeKey = input.cacheNamespace?.trim()
    ? input.cacheNamespace.trim()
    : scopedDocumentIds.length > 0
      ? `docs:${scopedDocumentIds.join(",")}`
      : "scope:all";
  const cacheKey = buildRetrievalCacheKey({
    normalizedQuery,
    language,
    retrievalVersion,
    topK,
    scopeKey,
  });

  // Best-effort cache hygiene for TTL expiry and retrieval version invalidation.
  try {
    await deps.pruneCache(retrievalVersion);
  } catch {
    // Continue retrieval flow even if cache prune fails.
  }

  let cached: { chunks: RetrievedChunk[]; candidateCounts: RetrievalTrace["candidateCounts"] } | null = null;
  try {
    cached = await deps.readCache({
      cacheKey,
      retrievalVersion,
      topK,
    });
  } catch {
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

  const candidateLimit = Math.max(topK * 4, env.RAG_RERANK_POOL_SIZE, MIN_CANDIDATE_LIMIT);
  const queryEmbedding = await deps.createEmbedding(normalizedQuery);
  const tokens = extractQueryTokens(normalizedQuery);

  const [languageVectorCandidates, languageKeywordCandidates] = await Promise.all([
    deps.searchVector({
      queryEmbedding,
      language,
      limit: candidateLimit,
      documentIds: scopedDocumentIds,
    }),
    deps.searchKeyword({
      normalizedQuery,
      tokens,
      language,
      limit: candidateLimit,
      documentIds: scopedDocumentIds,
    }),
  ]);

  let vectorCandidates = languageVectorCandidates;
  let keywordCandidates = languageKeywordCandidates;
  const languageConstrainedTotal = languageVectorCandidates.length + languageKeywordCandidates.length;
  const shouldUseCrossLanguageFallback =
    languageConstrainedTotal < topK || languageKeywordCandidates.length === 0;

  if (shouldUseCrossLanguageFallback) {
    const [crossLanguageVectorCandidates, crossLanguageKeywordCandidates] = await Promise.all([
      deps.searchVector({
        queryEmbedding,
        language: null,
        limit: candidateLimit,
        documentIds: scopedDocumentIds,
      }),
      deps.searchKeyword({
        normalizedQuery,
        tokens,
        language: null,
        limit: candidateLimit,
        documentIds: scopedDocumentIds,
      }),
    ]);

    vectorCandidates = mergeUniqueChunks(languageVectorCandidates, crossLanguageVectorCandidates);
    keywordCandidates = mergeUniqueChunks(languageKeywordCandidates, crossLanguageKeywordCandidates);
  }

  const fusedCandidates = reciprocalRankFusion({
    vectorCandidates,
    keywordCandidates,
    rrfK: env.RAG_RRF_K,
  });

  const rerankedCandidates = await deps.rerankCandidates({
    normalizedQuery,
    candidates: fusedCandidates,
    poolSize: env.RAG_RERANK_POOL_SIZE,
    topK,
  });

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
  } catch {
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
