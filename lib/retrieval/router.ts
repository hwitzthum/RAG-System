import { startActiveObservation } from "@langfuse/tracing";
import { env } from "@/lib/config/env";
import type {
  RetrievedChunk,
  RetrievalTrace,
  SupportedLanguage,
} from "@/lib/contracts/retrieval";
import { summarizeChunks } from "@/lib/observability/trace-payloads";
import { getDefaultProviders } from "@/lib/providers/defaults";
import { resolveRelevance } from "@/lib/answering/policy";
import { detectQueryLanguage } from "@/lib/retrieval/language";
import { generateQueryVariations } from "@/lib/retrieval/multi-query";
import {
  rankCandidatePool,
  retrieveRankedCandidates,
  type RerankCandidatesFn,
  type RetrieveRankedCandidatesInput,
  type RetrieveRankedCandidatesResult,
} from "@/lib/retrieval/service";
import { applyDocumentDiversity } from "@/lib/retrieval/diversity";
import { normalizeQuery } from "@/lib/retrieval/query";
import { decomposeQueryMemoized } from "@/lib/retrieval/decomposition";

type QueryExpansionTrace = {
  requested: boolean;
  applied: boolean;
  strategy: "standard" | "query_expansion";
  variationCount: number;
  branchCount: number;
};

type QueryDecompositionTrace = {
  requested: boolean;
  applied: boolean;
  subQueryCount: number;
  subQueries: string[];
};

export type RoutedRetrievalResult = RetrieveRankedCandidatesResult & {
  queryExpansion: QueryExpansionTrace;
  queryDecomposition: QueryDecompositionTrace;
};

type RoutedRetrievalDependencies = {
  retrieveBase: (
    input: RetrieveRankedCandidatesInput,
  ) => Promise<RetrieveRankedCandidatesResult>;
  generateVariations: (
    query: string,
    language: SupportedLanguage,
  ) => Promise<string[]>;
  decomposeQuery: (
    query: string,
    language: SupportedLanguage,
  ) => Promise<string[]>;
  rerankCandidates: RerankCandidatesFn;
};

type RetrieveWithRoutingInput = RetrieveRankedCandidatesInput & {
  enableQueryExpansion?: boolean;
};

type Branch = {
  kind: "base" | "variation";
  weight: number;
  query: string;
};

function getDefaultDependencies(): RoutedRetrievalDependencies {
  const providers = getDefaultProviders();
  return {
    retrieveBase: retrieveRankedCandidates,
    generateVariations: generateQueryVariations,
    decomposeQuery: decomposeQueryMemoized,
    rerankCandidates: providers.reranker.rerank,
  };
}

function normalizeDocumentScope(documentIds: string[] | undefined): string[] {
  return [
    ...new Set(
      (documentIds ?? [])
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ].sort();
}

function buildBranchCacheNamespace(
  cacheNamespace: string | undefined,
  suffix: string,
): string | undefined {
  if (!cacheNamespace) {
    return undefined;
  }

  return `${cacheNamespace}::${suffix}`;
}

/**
 * Merge candidate pools from several retrieval branches: dedupe by chunkId
 * keeping the entry with the best absolute relevance, sorted by that
 * relevance descending. Deliberately NOT fuseBranchCandidates — no rank
 * fusion, no pool trimming — so each chunk keeps honest cross-encoder scores
 * for the evidence gate and diversity promotion.
 */
export function mergeCandidatePools(
  pools: RetrievedChunk[][],
): RetrievedChunk[] {
  const byChunkId = new Map<string, RetrievedChunk>();
  for (const pool of pools) {
    for (const chunk of pool) {
      const existing = byChunkId.get(chunk.chunkId);
      if (!existing || resolveRelevance(chunk) > resolveRelevance(existing)) {
        byChunkId.set(chunk.chunkId, chunk);
      }
    }
  }
  return [...byChunkId.values()].sort(
    (a, b) => resolveRelevance(b) - resolveRelevance(a),
  );
}

function fuseBranchCandidates(
  branchResults: Array<{
    branch: Branch;
    result: RetrieveRankedCandidatesResult;
  }>,
): RetrievedChunk[] {
  const fused = new Map<string, RetrievedChunk>();
  const fusedScores = new Map<string, number>();

  for (const { branch, result } of branchResults) {
    for (const [index, chunk] of result.chunks.entries()) {
      const rank = index + 1;
      const score = branch.weight / (env.RAG_RRF_K + rank);
      const previousScore = fusedScores.get(chunk.chunkId) ?? 0;
      const nextScore = previousScore + score;
      fusedScores.set(chunk.chunkId, nextScore);

      const existing = fused.get(chunk.chunkId);
      if (!existing || nextScore >= (existing.retrievalScore ?? 0)) {
        fused.set(chunk.chunkId, {
          ...chunk,
          retrievalScore: nextScore,
        });
      } else {
        existing.retrievalScore = nextScore;
      }
    }
  }

  return [...fused.values()].sort(
    (left, right) => right.retrievalScore - left.retrievalScore,
  );
}

function summarizeCandidateCounts(
  branchResults: Array<{ result: RetrieveRankedCandidatesResult }>,
  fusedCount: number,
  rerankedCount: number,
): RetrievalTrace["candidateCounts"] {
  const totals = branchResults.reduce(
    (acc, item) => {
      acc.vector += item.result.trace.candidateCounts.vector;
      acc.keyword += item.result.trace.candidateCounts.keyword;
      return acc;
    },
    { vector: 0, keyword: 0 },
  );

  return {
    vector: totals.vector,
    keyword: totals.keyword,
    fused: fusedCount,
    reranked: rerankedCount,
  };
}

/**
 * Wraps the routing decision itself. The branch retrievals, expansion LLM
 * calls, and merge rerank nest underneath automatically through OpenTelemetry
 * context, so this observation is where a reviewer sees *which* strategy ran
 * and what the branches cost, without having to read the sub-tree.
 */
export async function retrieveRankedCandidatesWithRouting(
  input: RetrieveWithRoutingInput,
  overrides: Partial<RoutedRetrievalDependencies> = {},
): Promise<RoutedRetrievalResult> {
  return startActiveObservation(
    "route-query",
    async (observation) => {
      observation.update({
        input: {
          query: input.query,
          topK: input.topK,
          enableQueryExpansion: Boolean(input.enableQueryExpansion),
          documentIds: input.documentIds ?? null,
        },
      });

      const result = await retrieveRankedCandidatesWithRoutingUntraced(
        input,
        overrides,
      );

      observation.update({
        output: summarizeChunks(result.chunks),
        metadata: {
          queryExpansion: result.queryExpansion,
          queryDecomposition: result.queryDecomposition,
          cacheHit: result.trace.cacheHit,
        },
      });

      return result;
    },
    { asType: "chain" },
  );
}

async function retrieveRankedCandidatesWithRoutingUntraced(
  input: RetrieveWithRoutingInput,
  overrides: Partial<RoutedRetrievalDependencies> = {},
): Promise<RoutedRetrievalResult> {
  const deps = { ...getDefaultDependencies(), ...overrides };
  const scopedDocumentIds = normalizeDocumentScope(input.documentIds);
  // Expansion is a per-request user opt-in ("Broaden search") and applies to
  // any scope, including a single document or the whole corpus. It previously
  // required 2+ scoped documents, which meant HyDE and the variation branches
  // never ran in the default flow.
  const shouldExpand = Boolean(input.enableQueryExpansion);

  if (!shouldExpand) {
    // Start the base retrieval first so the decomposition LLM call (when
    // enabled) overlaps it instead of extending the critical path.
    const basePromise = deps.retrieveBase({
      query: input.query,
      topK: input.topK,
      languageHint: input.languageHint,
      documentIds: scopedDocumentIds,
      cacheNamespace: input.cacheNamespace,
    });

    const standardExpansionTrace: QueryExpansionTrace = {
      requested: shouldExpand,
      applied: false,
      strategy: "standard",
      variationCount: 0,
      branchCount: 1,
    };

    // Decomposition targets cross-document multi-topic queries, so a scope of
    // exactly one document cannot benefit and skips the LLM call.
    const decompositionEligible =
      env.RAG_QUERY_DECOMPOSITION_ENABLED && scopedDocumentIds.length !== 1;

    let subQueries: string[] = [];
    if (decompositionEligible) {
      const normalizedQuery = normalizeQuery(input.query);
      const language = detectQueryLanguage(normalizedQuery, input.languageHint);
      try {
        subQueries = await deps.decomposeQuery(normalizedQuery, language);
      } catch {
        subQueries = [];
      }

      if (subQueries.length >= 2) {
        // A failed sub-query branch degrades to an empty pool rather than
        // failing a request whose base retrieval succeeded.
        const subResults = (
          await Promise.all(
            subQueries.map((subQuery) =>
              deps
                .retrieveBase({
                  query: subQuery,
                  topK: input.topK,
                  // Short sub-queries misdetect easily; the blended original
                  // is the reliable language signal.
                  languageHint: language,
                  documentIds: scopedDocumentIds,
                  cacheNamespace: buildBranchCacheNamespace(
                    input.cacheNamespace,
                    "decomp",
                  ),
                })
                .catch(() => null),
            ),
          )
        ).filter(
          (result): result is RetrieveRankedCandidatesResult => result !== null,
        );

        const base = await basePromise;

        // Merge on per-pool RANK (weighted RRF), not absolute relevance:
        // Cohere scores are not comparable across query texts — the arm-1 A/B
        // (benchmark-2026-08-05T20-33-31-181Z) measured focused sub-queries
        // scoring their chunks 0.85-0.91 while the blended base query scored
        // its own golden window 0.4-0.5, so a relevance-max merge buried the
        // base window wholesale and EN nDCG fell. RRF's corroboration
        // property also keeps a bad split from displacing base results. The
        // base branch outweighs sub-queries for the same reason it outweighs
        // variations on the expansion path: it is the user's actual question.
        const fusedOrder = fuseBranchCandidates([
          {
            branch: { kind: "base", weight: 1, query: input.query },
            result: base,
          },
          ...subResults.map((result) => ({
            branch: {
              kind: "variation" as const,
              weight: 0.9,
              query: result.trace.normalizedQuery,
            },
            result,
          })),
        ]);

        // RRF decides the order; each chunk's absolute scores are rebuilt
        // from its best-scoring pool so the evidence gate and diversity
        // promotion still read honest cross-encoder relevance.
        const bestByChunkId = new Map(
          mergeCandidatePools([
            base.chunks,
            ...subResults.map((result) => result.chunks),
          ]).map((chunk) => [chunk.chunkId, chunk]),
        );
        let merged = fusedOrder.map((chunk) => ({
          ...(bestByChunkId.get(chunk.chunkId) ?? chunk),
          retrievalScore: chunk.retrievalScore,
        }));

        // Each branch capped itself per document, but the union can
        // concentrate more than the cap at the top; re-apply over the merge.
        if (env.RAG_MAX_CHUNKS_PER_DOCUMENT > 0) {
          merged = applyDocumentDiversity(merged, {
            topK: input.topK,
            maxPerDocument: env.RAG_MAX_CHUNKS_PER_DOCUMENT,
            relevanceFloor: env.RAG_DIVERSITY_RELEVANCE_FLOOR,
          });
        }

        const mergedWindow = merged.slice(0, input.topK);
        const candidateCounts = summarizeCandidateCounts(
          [{ result: base }, ...subResults.map((result) => ({ result }))],
          merged.length,
          mergedWindow.length,
        );

        return {
          chunks: mergedWindow,
          trace: {
            ...base.trace,
            // Label only, mirroring the expansion path's `::expanded`; the
            // merged window is never written to the cache under this key.
            cacheKey: `${base.trace.cacheKey}::decomposed`,
            cacheHit:
              base.trace.cacheHit &&
              subResults.every((result) => result.trace.cacheHit),
            candidateCounts,
          },
          queryExpansion: standardExpansionTrace,
          queryDecomposition: {
            requested: true,
            applied: true,
            subQueryCount: subQueries.length,
            subQueries,
          },
        };
      }
    }

    const base = await basePromise;
    return {
      ...base,
      queryExpansion: standardExpansionTrace,
      queryDecomposition: {
        requested: decompositionEligible,
        applied: false,
        subQueryCount: 0,
        subQueries: [],
      },
    };
  }

  const normalizedQuery = normalizeQuery(input.query);
  const language = detectQueryLanguage(normalizedQuery, input.languageHint);
  const branchTopK = Math.max(
    input.topK,
    Math.min(env.RAG_RERANK_POOL_SIZE, Math.max(input.topK * 2, 8)),
  );

  const queries = await deps.generateVariations(normalizedQuery, language);

  const uniqueVariations = [
    ...new Set(
      queries.map((query) => query.trim()).filter((query) => query.length > 0),
    ),
  ].filter((query) => query.toLowerCase() !== normalizedQuery.toLowerCase());

  const branches: Branch[] = [
    { kind: "base", weight: 1, query: input.query },
    ...uniqueVariations.map((query) => ({
      kind: "variation" as const,
      weight: 0.9,
      query,
    })),
  ];

  const branchResults = await Promise.all(
    branches.map(async (branch, index) => ({
      branch,
      result: await deps.retrieveBase({
        query: branch.query,
        topK: branchTopK,
        languageHint: input.languageHint,
        documentIds: scopedDocumentIds,
        cacheNamespace: buildBranchCacheNamespace(
          input.cacheNamespace,
          `${branch.kind}-${index}`,
        ),
      }),
    })),
  );

  const fusedCandidates = fuseBranchCandidates(branchResults).slice(
    0,
    Math.max(env.RAG_RERANK_POOL_SIZE, input.topK * 4),
  );
  // Same ranking chain as the core service, over the fused pool.
  const orderedCandidates = await rankCandidatePool({
    normalizedQuery,
    candidates: fusedCandidates,
    topK: input.topK,
    language,
    rerankCandidates: deps.rerankCandidates,
  });

  const rerankedCandidates = orderedCandidates.slice(0, input.topK);

  const baseTrace = branchResults[0]!.result.trace;
  const candidateCounts = summarizeCandidateCounts(
    branchResults,
    fusedCandidates.length,
    rerankedCandidates.length,
  );

  return {
    chunks: rerankedCandidates,
    trace: {
      normalizedQuery: baseTrace.normalizedQuery,
      language: baseTrace.language,
      cacheKey: `${baseTrace.cacheKey}::expanded`,
      cacheHit: branchResults.every((item) => item.result.trace.cacheHit),
      retrievalVersion: baseTrace.retrievalVersion,
      configFingerprint: baseTrace.configFingerprint,
      topK: input.topK,
      candidateCounts,
    },
    queryExpansion: {
      requested: true,
      applied: true,
      strategy: "query_expansion",
      variationCount: uniqueVariations.length,
      branchCount: branches.length,
    },
    // Expansion already broadens the query; the two mechanisms stay
    // orthogonal, so decomposition is never attempted on this path.
    queryDecomposition: {
      requested: false,
      applied: false,
      subQueryCount: 0,
      subQueries: [],
    },
  };
}
