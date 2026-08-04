import { env } from "@/lib/config/env";
import type {
  RetrievedChunk,
  RetrievalTrace,
  SupportedLanguage,
} from "@/lib/contracts/retrieval";
import { getDefaultProviders } from "@/lib/providers/defaults";
import { detectQueryLanguage } from "@/lib/retrieval/language";
import { generateQueryVariations } from "@/lib/retrieval/multi-query";
import {
  retrieveRankedCandidates,
  type RetrieveRankedCandidatesInput,
  type RetrieveRankedCandidatesResult,
} from "@/lib/retrieval/service";
import { crossEncoderRerank } from "@/lib/retrieval/cross-encoder";
import { applyContextualGrouping } from "@/lib/retrieval/contextual-grouping";
import { normalizeQuery } from "@/lib/retrieval/query";
import { generateHypotheticalDocument } from "@/lib/retrieval/hyde";

type QueryExpansionTrace = {
  requested: boolean;
  applied: boolean;
  strategy: "standard" | "query_expansion";
  variationCount: number;
  hydeUsed: boolean;
  branchCount: number;
};

export type RoutedRetrievalResult = RetrieveRankedCandidatesResult & {
  queryExpansion: QueryExpansionTrace;
};

type RoutedRetrievalDependencies = {
  retrieveBase: (
    input: RetrieveRankedCandidatesInput,
  ) => Promise<RetrieveRankedCandidatesResult>;
  generateVariations: (
    query: string,
    language: SupportedLanguage,
  ) => Promise<string[]>;
  generateHyde: (input: {
    query: string;
    language: SupportedLanguage;
  }) => Promise<string | null>;
  rerankCandidates: (input: {
    normalizedQuery: string;
    candidates: RetrievedChunk[];
    poolSize: number;
    language?: SupportedLanguage;
  }) => Promise<RetrievedChunk[]>;
};

type RetrieveWithRoutingInput = RetrieveRankedCandidatesInput & {
  enableQueryExpansion?: boolean;
};

type Branch = {
  kind: "base" | "variation" | "hyde";
  weight: number;
  query: string;
};

function getDefaultDependencies(): RoutedRetrievalDependencies {
  const providers = getDefaultProviders();
  return {
    retrieveBase: retrieveRankedCandidates,
    generateVariations: generateQueryVariations,
    generateHyde: generateHypotheticalDocument,
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

export async function retrieveRankedCandidatesWithRouting(
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
    const base = await deps.retrieveBase({
      query: input.query,
      topK: input.topK,
      languageHint: input.languageHint,
      documentIds: scopedDocumentIds,
      cacheNamespace: input.cacheNamespace,
      disableMultiQuery: input.disableMultiQuery,
    });

    return {
      ...base,
      queryExpansion: {
        requested: shouldExpand,
        applied: false,
        strategy: "standard",
        variationCount: 0,
        hydeUsed: false,
        branchCount: 1,
      },
    };
  }

  const normalizedQuery = normalizeQuery(input.query);
  const language = detectQueryLanguage(normalizedQuery, input.languageHint);
  const branchTopK = Math.max(
    input.topK,
    Math.min(env.RAG_RERANK_POOL_SIZE, Math.max(input.topK * 2, 8)),
  );

  const [queries, hydePassage] = await Promise.all([
    deps.generateVariations(normalizedQuery, language),
    env.RAG_HYDE_ENABLED
      ? deps.generateHyde({ query: normalizedQuery, language })
      : Promise.resolve(null),
  ]);

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

  if (
    hydePassage &&
    hydePassage.trim().toLowerCase() !== normalizedQuery.toLowerCase()
  ) {
    branches.push({ kind: "hyde", weight: 0.75, query: hydePassage });
  }

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
        // This branch is already a query variation. Without this the service
        // would expand it again, turning N branches into N x variations
        // embedding calls per request.
        disableMultiQuery: true,
      }),
    })),
  );

  const fusedCandidates = fuseBranchCandidates(branchResults).slice(
    0,
    Math.max(env.RAG_RERANK_POOL_SIZE, input.topK * 4),
  );
  // Same stage order as the core service: heuristic rerank scores the full
  // fused pool, the cross-encoder re-orders that full pool, grouping applies
  // its adjacency boost, and only then is the list cut to topK.
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
      // Fall back to reranker order if cross-encoder fails.
    }
  }

  if (env.RAG_CONTEXTUAL_GROUPING_ENABLED) {
    orderedCandidates = applyContextualGrouping(orderedCandidates);
  }

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
      topK: input.topK,
      candidateCounts,
    },
    queryExpansion: {
      requested: true,
      applied: true,
      strategy: "query_expansion",
      variationCount: uniqueVariations.length,
      hydeUsed: branches.some((branch) => branch.kind === "hyde"),
      branchCount: branches.length,
    },
  };
}
