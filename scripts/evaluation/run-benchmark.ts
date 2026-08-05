#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import type {
  Citation,
  RetrievedChunk,
  SupportedLanguage,
} from "../../lib/contracts/retrieval";
import { validateEvaluationDataset } from "../../lib/evaluation/dataset";
import {
  computeAnswerMetrics,
  computeRetrievalMetrics,
  evaluateThresholds,
  formatMetric,
  languageOrder,
  summarizeBenchmark,
} from "../../lib/evaluation/metrics";
import {
  DEFAULT_BENCHMARK_THRESHOLDS,
  JUDGE_NOISE_FLOOR,
  type EvaluationQueryRecord,
  type QueryBenchmarkResult,
  type QueryFailure,
  type ScoreScaleComposition,
} from "../../lib/evaluation/types";

type RunnerMode = "live" | "dry-run";

type RunnerArgs = {
  datasetPath: string;
  reportsDir: string;
  runsDir: string;
  mode: RunnerMode;
  topK: number;
  sampleSize: number | null;
  languages: SupportedLanguage[] | null;
  failOnGate: boolean;
  /** Exercise the router's "Broaden search" expansion path (default off, matching default UX). */
  expansion: boolean;
  /** LLM-judge metrics; defaults on for live mode, always off for dry-run. */
  judge: boolean;
  /**
   * Judge retrieval relevance on document + page only, ignoring
   * `expected_section`.
   *
   * Strictly an A/B instrument for changes that alter `section_title`, where
   * the golden set's stored labels no longer describe the corpus and the
   * substring match fails for reasons unrelated to retrieval. Defaults off:
   * release gates are judged on the strict definition, and this loosens it.
   */
  ignoreExpectedSection: boolean;
  /**
   * Per-run retrieval cache namespace. Without it the "cached" pass measured
   * whatever a previous run (possibly under a different ranking config) had
   * left in `retrieval_cache` rather than this run's own cache latency.
   */
  cacheNamespace: string;
};

type RunCapture = {
  chunks: RetrievedChunk[];
  candidateCounts: {
    vector: number;
    keyword: number;
    fused: number;
    reranked: number;
  };
  cacheHit: boolean;
  answer: string;
  citations: Citation[];
  insufficientEvidence: boolean;
  latencyMs: number;
  /** Production citation-verifier result; null when disabled or blocked. */
  citationVerification: {
    checkedCount: number;
    supportedCount: number;
    unsupportedCount: number;
    unverified: boolean;
  } | null;
  /**
   * The generator hit RAG_LLM_MAX_OUTPUT_TOKENS. A non-zero rate across a run
   * is a configuration bug, not a quality signal: a severed final sentence
   * with a dangling [n] marker scores as an unsupported statement and depresses
   * faithfulness for a reason unrelated to grounding.
   */
  answerTruncated: boolean;
};

type QueryExecution = {
  uncached: RunCapture;
  cached: RunCapture;
};

type LiveDependencies = {
  retrieveRankedCandidates: typeof import("../../lib/retrieval/service").retrieveRankedCandidates;
  retrieveRankedCandidatesWithRouting: typeof import("../../lib/retrieval/router").retrieveRankedCandidatesWithRouting;
  generateGroundedAnswer: typeof import("../../lib/answering/service").generateGroundedAnswer;
  judgeQueryResult: typeof import("../../lib/evaluation/llm-judge").judgeQueryResult;
  retrievalConfigFingerprint: string;
  env: typeof import("../../lib/config/env").env;
};

let liveDependenciesPromise: Promise<LiveDependencies> | null = null;

async function loadLiveDependencies(): Promise<LiveDependencies> {
  if (!liveDependenciesPromise) {
    liveDependenciesPromise = Promise.all([
      import("../../lib/retrieval/service"),
      import("../../lib/retrieval/router"),
      import("../../lib/answering/service"),
      import("../../lib/evaluation/llm-judge"),
      import("../../lib/config/env"),
    ]).then(
      ([
        retrievalModule,
        routerModule,
        answerModule,
        judgeModule,
        envModule,
      ]) => ({
        retrieveRankedCandidates: retrievalModule.retrieveRankedCandidates,
        retrieveRankedCandidatesWithRouting:
          routerModule.retrieveRankedCandidatesWithRouting,
        generateGroundedAnswer: answerModule.generateGroundedAnswer,
        judgeQueryResult: judgeModule.judgeQueryResult,
        retrievalConfigFingerprint:
          retrievalModule.RETRIEVAL_CONFIG_FINGERPRINT,
        env: envModule.env,
      }),
    );
  }

  return liveDependenciesPromise;
}

function parseArgs(argv: string[]): RunnerArgs {
  const args: RunnerArgs = {
    // The corpus-derived golden set: an envelope binding records to the
    // corpus fingerprint they were generated from. (The old 200-record
    // synthetic fixture named documents that existed nowhere in the corpus,
    // so benchmarking against it measured nothing; it was deleted in 3.1.)
    datasetPath: "evaluation/evaluation_queries.generated.json",
    reportsDir: "evaluation/reports",
    runsDir: "evaluation/runs",
    mode: "live",
    topK: 8,
    sampleSize: null,
    languages: null,
    failOnGate: true,
    expansion: false,
    judge: true,
    ignoreExpectedSection: false,
    cacheNamespace: `benchmark:${new Date().toISOString()}`,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dataset") {
      args.datasetPath = argv[index + 1] ?? args.datasetPath;
      index += 1;
    } else if (token === "--reports-dir") {
      args.reportsDir = argv[index + 1] ?? args.reportsDir;
      index += 1;
    } else if (token === "--runs-dir") {
      args.runsDir = argv[index + 1] ?? args.runsDir;
      index += 1;
    } else if (token === "--mode") {
      const mode = (argv[index + 1] ?? args.mode) as RunnerMode;
      if (mode === "live" || mode === "dry-run") {
        args.mode = mode;
      }
      index += 1;
    } else if (token === "--top-k") {
      const parsed = Number.parseInt(argv[index + 1] ?? `${args.topK}`, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        args.topK = parsed;
      }
      index += 1;
    } else if (token === "--sample") {
      const parsed = Number.parseInt(argv[index + 1] ?? "0", 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        args.sampleSize = parsed;
      }
      index += 1;
    } else if (token === "--languages") {
      const raw = argv[index + 1] ?? "";
      const parsed = raw
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter((value): value is SupportedLanguage =>
          ["EN", "DE", "FR", "IT", "ES"].includes(value),
        );
      args.languages = parsed.length > 0 ? parsed : null;
      index += 1;
    } else if (token === "--no-fail-on-gate") {
      args.failOnGate = false;
    } else if (token === "--expansion") {
      args.expansion = true;
    } else if (token === "--no-judge") {
      args.judge = false;
    } else if (token === "--ignore-expected-section") {
      args.ignoreExpectedSection = true;
    }
  }

  // The judge only makes sense against real answers.
  if (args.mode === "dry-run") {
    args.judge = false;
  }

  return args;
}

function selectRecords(
  records: EvaluationQueryRecord[],
  args: RunnerArgs,
): EvaluationQueryRecord[] {
  const filtered =
    args.languages && args.languages.length > 0
      ? records.filter((record) => args.languages?.includes(record.language))
      : records;

  if (!args.sampleSize || args.sampleSize >= filtered.length) {
    return filtered;
  }

  return filtered.slice(0, args.sampleSize);
}

function deterministicHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function deterministicNumber(value: string, min: number, max: number): number {
  const hash = deterministicHash(value);
  return min + (hash % (max - min + 1));
}

function buildMockChunk(
  query: EvaluationQueryRecord,
  rank: number,
  isRelevant: boolean,
  language: SupportedLanguage,
  relevantPage?: number,
): RetrievedChunk {
  // Relevance is now an exact chunk-id hit, so a relevant mock chunk must
  // carry one of the golden ids rather than a fabricated one.
  const chunkId = isRelevant
    ? (query.expected_chunk_ids[rank] ??
      query.expected_chunk_ids[0] ??
      `${query.id}-rel-${rank}`)
    : `${query.id}-noise-${rank}`;
  return {
    chunkId,
    documentId: isRelevant ? query.expected_document : `noise_doc_${rank}`,
    pageNumber: isRelevant
      ? (relevantPage ?? query.expected_pages[0] ?? 1)
      : rank + 40,
    sectionTitle: isRelevant ? query.expected_section : "Unrelated Section",
    content: isRelevant
      ? `${query.acceptable_answer_points.join(". ")}.`
      : "This chunk contains unrelated operational commentary.",
    context: isRelevant ? "Expected evidence context." : "Noise context.",
    language,
    source: rank % 2 === 0 ? "vector" : "keyword",
    retrievalScore: Math.max(0.1, 1 - rank * 0.05),
    rerankScore: Math.max(0.1, 1 - rank * 0.07),
    vectorScore: Math.max(0.1, 1 - rank * 0.08),
  };
}

function executeDryRun(
  query: EvaluationQueryRecord,
  topK: number,
): QueryExecution {
  const language = query.language;
  const uncachedLatencyMs = deterministicNumber(
    `${query.id}:uncached`,
    900,
    1900,
  );
  const cachedLatencyMs = deterministicNumber(`${query.id}:cached`, 180, 640);

  const chunks: RetrievedChunk[] = [];
  const chunkLimit = Math.max(topK, 8);

  let rank = 0;
  for (const pageNumber of query.expected_pages) {
    if (rank >= chunkLimit) {
      break;
    }
    chunks.push(buildMockChunk(query, rank, true, language, pageNumber));
    rank += 1;
  }

  while (rank < chunkLimit) {
    chunks.push(buildMockChunk(query, rank, false, language));
    rank += 1;
  }

  // The mock system behaves correctly: it abstains on unanswerable questions.
  const unanswerable = query.question_type === "unanswerable";
  const answerText = unanswerable
    ? "Insufficient evidence."
    : `${query.acceptable_answer_points[0]}. ${query.acceptable_answer_points[1]}. ${query.acceptable_answer_points[2]}.`;
  const citations: Citation[] = unanswerable
    ? []
    : [
        {
          documentId: query.expected_document,
          pageNumber: query.expected_pages[0] ?? 1,
          chunkId: chunks[0]?.chunkId ?? `${query.id}-citation`,
        },
      ];

  return {
    uncached: {
      chunks,
      candidateCounts: {
        vector: chunks.length,
        keyword: chunks.length,
        fused: chunks.length,
        reranked: Math.min(chunks.length, topK),
      },
      cacheHit: false,
      answer: answerText,
      citations,
      insufficientEvidence: unanswerable,
      latencyMs: uncachedLatencyMs,
      citationVerification: unanswerable
        ? null
        : {
            checkedCount: 3,
            supportedCount: 3,
            unsupportedCount: 0,
            unverified: false,
          },
      answerTruncated: false,
    },
    cached: {
      chunks,
      candidateCounts: {
        vector: chunks.length,
        keyword: chunks.length,
        fused: chunks.length,
        reranked: Math.min(chunks.length, topK),
      },
      cacheHit: true,
      answer: answerText,
      citations,
      insufficientEvidence: unanswerable,
      latencyMs: cachedLatencyMs,
      citationVerification: unanswerable
        ? null
        : {
            checkedCount: 3,
            supportedCount: 3,
            unsupportedCount: 0,
            unverified: false,
          },
      answerTruncated: false,
    },
  };
}

async function executeLive(
  query: EvaluationQueryRecord,
  topK: number,
  expansion: boolean,
  cacheNamespace: string,
): Promise<QueryExecution> {
  const deps = await loadLiveDependencies();

  const uncachedStart = Date.now();
  // Route through the router (the production entry point) so query expansion,
  // HyDE, and branch fusion are exercised by the benchmark. The cache bypass
  // moves into a retrieveBase override because the router itself takes no
  // cache dependencies.
  const uncachedRetrieval = await deps.retrieveRankedCandidatesWithRouting(
    {
      query: query.question,
      topK,
      languageHint: query.language,
      enableQueryExpansion: expansion,
      cacheNamespace,
    },
    {
      retrieveBase: (input) =>
        deps.retrieveRankedCandidates(input, {
          // Force cache bypass to measure true uncached retrieval latency.
          readCache: async () => null,
        }),
    },
  );
  const uncachedAnswer = await deps.generateGroundedAnswer({
    query: query.question,
    language: uncachedRetrieval.trace.language,
    chunks: uncachedRetrieval.chunks,
    minEvidenceChunks: deps.env.RAG_MIN_EVIDENCE_CHUNKS,
    minRerankScore: deps.env.RAG_MIN_RERANK_SCORE,
    minHeuristicRelevance: deps.env.RAG_MIN_HEURISTIC_RELEVANCE,
    maxOutputTokens: deps.env.RAG_LLM_MAX_OUTPUT_TOKENS,
  });
  const uncachedLatencyMs = Date.now() - uncachedStart;

  const cachedStart = Date.now();
  const cachedRetrieval = await deps.retrieveRankedCandidatesWithRouting({
    query: query.question,
    topK,
    languageHint: query.language,
    enableQueryExpansion: expansion,
    cacheNamespace,
  });
  const cachedAnswer = await deps.generateGroundedAnswer({
    query: query.question,
    language: cachedRetrieval.trace.language,
    chunks: cachedRetrieval.chunks,
    minEvidenceChunks: deps.env.RAG_MIN_EVIDENCE_CHUNKS,
    minRerankScore: deps.env.RAG_MIN_RERANK_SCORE,
    minHeuristicRelevance: deps.env.RAG_MIN_HEURISTIC_RELEVANCE,
    maxOutputTokens: deps.env.RAG_LLM_MAX_OUTPUT_TOKENS,
  });
  const cachedLatencyMs = Date.now() - cachedStart;

  return {
    uncached: {
      chunks: uncachedRetrieval.chunks,
      candidateCounts: uncachedRetrieval.trace.candidateCounts,
      cacheHit: uncachedRetrieval.trace.cacheHit,
      answer: uncachedAnswer.answer,
      citations: uncachedAnswer.citations,
      insufficientEvidence: uncachedAnswer.insufficientEvidence,
      latencyMs: uncachedLatencyMs,
      citationVerification: uncachedAnswer.citationVerification,
      answerTruncated: uncachedAnswer.answerTruncated,
    },
    cached: {
      chunks: cachedRetrieval.chunks,
      candidateCounts: cachedRetrieval.trace.candidateCounts,
      cacheHit: cachedRetrieval.trace.cacheHit,
      answer: cachedAnswer.answer,
      citations: cachedAnswer.citations,
      insufficientEvidence: cachedAnswer.insufficientEvidence,
      latencyMs: cachedLatencyMs,
      citationVerification: cachedAnswer.citationVerification,
      answerTruncated: cachedAnswer.answerTruncated,
    },
  };
}

type RunConfig = {
  topK: number;
  expansion: boolean;
  judge: boolean;
  /** Recorded so a page-only run can never be mistaken for a strict one. */
  ignoreExpectedSection: boolean;
  cacheNamespace: string;
  retrievalConfigFingerprint: string;
  generatorModel: string;
  judgeModel: string;
  citationVerifierModel: string;
  queryEmbeddingModel: string;
  queryEmbeddingDimensions: number;
  retrievalVersion: number;
  rrfK: number;
  rerankPoolSize: number;
  llmMaxOutputTokens: number;
  minEvidenceChunks: number;
  minRerankScore: number;
  minHeuristicRelevance: number;
  cacheTtlSeconds: number;
  crossEncoderEnabled: boolean;
  crossEncoderModel: string;
  crossEncoderTimeoutMs: number;
  crossEncoderIncludeContext: boolean;
  hydeEnabled: boolean;
  contextualGroupingEnabled: boolean;
  adjacencyBoost: number;
  maxChunksPerDocument: number;
  diversityRelevanceFloor: number;
  multiQueryEnabled: boolean;
  multiQueryVariations: number;
  evidencePlacement: string;
  citationVerificationEnabled: boolean;
  webSearchEnabled: boolean;
  webMinSources: number;
};

/**
 * Ten stored runs were previously indistinguishable by configuration: nothing
 * in the artifact recorded which flags, models or pool sizes produced the
 * numbers, so no two runs could honestly be compared. Null in dry-run mode,
 * where no live environment is loaded.
 */
async function buildRunConfig(args: RunnerArgs): Promise<RunConfig | null> {
  if (args.mode !== "live") {
    return null;
  }

  const deps = await loadLiveDependencies();
  const env = deps.env;

  return {
    topK: args.topK,
    expansion: args.expansion,
    judge: args.judge,
    ignoreExpectedSection: args.ignoreExpectedSection,
    cacheNamespace: args.cacheNamespace,
    retrievalConfigFingerprint: deps.retrievalConfigFingerprint,
    generatorModel: env.RAG_LLM_MODEL,
    judgeModel: env.RAG_EVAL_JUDGE_MODEL,
    citationVerifierModel: env.RAG_CITATION_VERIFIER_MODEL,
    queryEmbeddingModel: env.RAG_QUERY_EMBEDDING_MODEL,
    queryEmbeddingDimensions: env.RAG_QUERY_EMBEDDING_DIMENSIONS,
    retrievalVersion: env.RAG_RETRIEVAL_VERSION,
    rrfK: env.RAG_RRF_K,
    rerankPoolSize: env.RAG_RERANK_POOL_SIZE,
    llmMaxOutputTokens: env.RAG_LLM_MAX_OUTPUT_TOKENS,
    minEvidenceChunks: env.RAG_MIN_EVIDENCE_CHUNKS,
    minRerankScore: env.RAG_MIN_RERANK_SCORE,
    minHeuristicRelevance: env.RAG_MIN_HEURISTIC_RELEVANCE,
    cacheTtlSeconds: env.RAG_CACHE_TTL_SECONDS,
    crossEncoderEnabled: env.RAG_CROSS_ENCODER_ENABLED,
    crossEncoderModel: env.RAG_CROSS_ENCODER_MODEL,
    crossEncoderTimeoutMs: env.RAG_CROSS_ENCODER_TIMEOUT_MS,
    crossEncoderIncludeContext: env.RAG_CROSS_ENCODER_INCLUDE_CONTEXT,
    hydeEnabled: env.RAG_HYDE_ENABLED,
    contextualGroupingEnabled: env.RAG_CONTEXTUAL_GROUPING_ENABLED,
    adjacencyBoost: env.RAG_ADJACENCY_BOOST,
    maxChunksPerDocument: env.RAG_MAX_CHUNKS_PER_DOCUMENT,
    diversityRelevanceFloor: env.RAG_DIVERSITY_RELEVANCE_FLOOR,
    multiQueryEnabled: env.RAG_MULTI_QUERY_ENABLED,
    multiQueryVariations: env.RAG_MULTI_QUERY_VARIATIONS,
    evidencePlacement: env.RAG_EVIDENCE_PLACEMENT,
    citationVerificationEnabled: env.RAG_CITATION_VERIFICATION_ENABLED,
    webSearchEnabled: env.RAG_WEB_SEARCH_ENABLED,
    webMinSources: env.RAG_WEB_MIN_SOURCES,
  };
}

function toFailure(
  failureType: QueryFailure["failureType"],
  probableRootCause: string,
  queryId: string,
): QueryFailure {
  return {
    failureType,
    probableRootCause,
    remediationTicket: `TODO-EVAL-${queryId}`,
  };
}

function deriveFailures(
  query: EvaluationQueryRecord,
  retrievalMetrics: ReturnType<typeof computeRetrievalMetrics>,
  answerMetrics: ReturnType<typeof computeAnswerMetrics>,
  judge: QueryBenchmarkResult["judge"],
  insufficientEvidence: boolean,
  uncachedLatencyMs: number,
  cachedLatencyMs: number,
  cacheHitOnRepeat: boolean,
): QueryFailure[] {
  const queryId = query.id;
  const failures: QueryFailure[] = [];

  // An unanswerable question has no gold evidence: its only quality signal
  // is whether the system abstained. Latency/cache checks below still apply.
  if (query.question_type === "unanswerable") {
    if (!insufficientEvidence) {
      failures.push(
        toFailure(
          "abstention",
          "System answered a question whose evidence is provably absent from the corpus (false answer).",
          queryId,
        ),
      );
    }
    return [
      ...failures,
      ...deriveOperationalFailures(
        queryId,
        uncachedLatencyMs,
        cachedLatencyMs,
        cacheHitOnRepeat,
      ),
    ];
  }

  if (insufficientEvidence) {
    failures.push(
      toFailure(
        "abstention",
        "System abstained on a question the golden set considers answerable (false abstention).",
        queryId,
      ),
    );
  }

  if (retrievalMetrics.recallAt5 < 1) {
    failures.push(
      toFailure(
        "retrieval",
        "Expected evidence was not retrieved within top-5 ranked chunks.",
        queryId,
      ),
    );
  }

  if (answerMetrics.citationEvidenceHit < 1) {
    failures.push(
      toFailure(
        "citation",
        "No citation pointed to the expected document/page evidence.",
        queryId,
      ),
    );
  }

  if (
    answerMetrics.verifiedCitationRate !== null &&
    answerMetrics.verifiedCitationRate <
      DEFAULT_BENCHMARK_THRESHOLDS.verifiedCitationRate
  ) {
    failures.push(
      toFailure(
        "citation",
        "Citation verifier judged one or more cited sentences unsupported by their sources.",
        queryId,
      ),
    );
  }

  // Driven by the LLM judge, not the token-overlap metric: the latter is now
  // report-only because it could not fail.
  if (
    judge?.judged &&
    judge.faithfulness !== null &&
    judge.faithfulness < DEFAULT_BENCHMARK_THRESHOLDS.faithfulnessMin
  ) {
    failures.push(
      toFailure(
        "grounding",
        `Judge found ${judge.unsupportedStatementCount ?? "one or more"} answer statement(s) unsupported by the retrieved evidence.`,
        queryId,
      ),
    );
  }

  return [
    ...failures,
    ...deriveOperationalFailures(
      queryId,
      uncachedLatencyMs,
      cachedLatencyMs,
      cacheHitOnRepeat,
    ),
  ];
}

/** Latency and cache checks apply to every query, answerable or not. */
function deriveOperationalFailures(
  queryId: string,
  uncachedLatencyMs: number,
  cachedLatencyMs: number,
  cacheHitOnRepeat: boolean,
): QueryFailure[] {
  const failures: QueryFailure[] = [];

  if (
    uncachedLatencyMs >= DEFAULT_BENCHMARK_THRESHOLDS.uncachedP95LatencyMs ||
    cachedLatencyMs >= DEFAULT_BENCHMARK_THRESHOLDS.cachedP95LatencyMs
  ) {
    failures.push(
      toFailure(
        "latency",
        "Query latency exceeded release threshold for cached or uncached execution.",
        queryId,
      ),
    );
  }

  if (!cacheHitOnRepeat) {
    failures.push(
      toFailure(
        "cache",
        "Repeated query did not hit retrieval cache with same retrieval version/key inputs.",
        queryId,
      ),
    );
  }

  return failures;
}

function buildMarkdownReport(input: {
  mode: RunnerMode;
  datasetPath: string;
  runPath: string;
  generatedAt: string;
  queryCount: number;
  corpusFingerprint: string;
  config: RunConfig | null;
  summary: ReturnType<typeof summarizeBenchmark>;
  thresholdEvaluation: ReturnType<typeof evaluateThresholds>;
  results: QueryBenchmarkResult[];
}): string {
  const overall = input.summary.overall;
  const languageRows = languageOrder()
    .map((language) => {
      const metrics = input.summary.byLanguage[language];
      return `| ${language} | ${metrics.queryCount} | ${formatMetric(metrics.recallAt5)} | ${formatMetric(metrics.ndcgAt10)} | ${formatMetric(metrics.citationAccuracy)} | ${metrics.judgedCount > 0 ? formatMetric(metrics.faithfulness) : "n/a"} | ${formatMetric(metrics.cacheHitRate)} | ${formatMetric(metrics.uncachedP95LatencyMs)} | ${formatMetric(metrics.cachedP95LatencyMs)} |`;
    })
    .join("\n");

  const thresholdRows = input.thresholdEvaluation.checks
    .map(
      (check) =>
        `| ${check.metric} | ${check.target} | ${formatMetric(check.actual)} | ${check.passed ? "PASS" : "FAIL"} |`,
    )
    .join("\n");

  const failedQueries = input.results.filter(
    (result) => result.failures.length > 0 || result.error,
  );
  const openRisks = [
    ...input.thresholdEvaluation.checks
      .filter((check) => !check.passed)
      .map(
        (check) =>
          `${check.metric} gate failed (actual ${formatMetric(check.actual)}, target ${check.target}).`,
      ),
    ...(overall.systemErrorCount > 0
      ? [
          `System errors detected for ${overall.systemErrorCount} queries (${formatMetric(overall.systemErrorRate)} rate).`,
        ]
      : []),
    ...(failedQueries.length > 0
      ? [
          `${failedQueries.length} queries include at least one failure type requiring triage.`,
        ]
      : []),
  ];

  const failureTableRows = failedQueries
    .slice(0, 25)
    .map((result) => {
      const types = result.error
        ? "system_error"
        : result.failures.map((failure) => failure.failureType).join(", ");
      return `| ${result.id} | ${result.language} | ${types || "none"} |`;
    })
    .join("\n");

  const recommendation = input.thresholdEvaluation.passed
    ? "Proceed to release candidate review."
    : "Release blocked until failed gates are remediated and benchmark is re-run.";

  const configRows = input.config
    ? Object.entries(input.config)
        .map(([key, value]) => `| ${key} | \`${String(value)}\` |`)
        .join("\n")
    : "| n/a | dry-run: no live configuration loaded |";

  return `# Phase 11 Benchmark Report

Generated: ${input.generatedAt}
Mode: ${input.mode}
Dataset: ${path.resolve(input.datasetPath)}
Corpus fingerprint: \`${input.corpusFingerprint}\`
Run artifact: ${path.resolve(input.runPath)}
Evaluated queries: ${input.queryCount}
Generator model: ${input.config?.generatorModel ?? "n/a"}
Judge model: ${input.config?.judgeModel ?? "n/a"}

## Run Configuration

| Setting | Value |
| --- | --- |
${configRows}

## Summary

| Metric | Value |
| --- | ---: |
| Query count | ${overall.queryCount} |
| Evaluated queries | ${overall.evaluatedCount} |
| System error count | ${overall.systemErrorCount} |
| Answerable / unanswerable | ${overall.answerableCount} / ${overall.unanswerableCount} |
| False answer rate (unanswerable slice) | ${overall.unanswerableCount > 0 ? formatMetric(overall.falseAnswerRate) : "n/a — dataset has no unanswerable slice"} |
| False abstention rate (answerable slice) | ${formatMetric(overall.falseAbstentionRate)} |
| Recall@5 | ${formatMetric(overall.recallAt5)} |
| nDCG@10 | ${formatMetric(overall.ndcgAt10)} |
| MRR | ${formatMetric(overall.mrr)} |
| Citation evidence hit rate | ${formatMetric(overall.citationEvidenceHitRate)} |
| Verified citation rate | ${overall.verifiedQueryCount > 0 ? formatMetric(overall.verifiedCitationRate) : "n/a"} (${overall.verifiedQueryCount} verified) |
| Citation accuracy (strict, report-only) | ${formatMetric(overall.citationAccuracy)} |
| Answer truncation rate${overall.truncationRate > 0 ? " **(CONFIG BUG - answer metrics below are not trustworthy)**" : ""} | ${formatMetric(overall.truncationRate)} |
| Cache hit rate | ${formatMetric(overall.cacheHitRate)} |
| Uncached p50 latency (ms) | ${formatMetric(overall.uncachedP50LatencyMs)} |
| Uncached p95 latency (ms) | ${formatMetric(overall.uncachedP95LatencyMs)} |
| Cached p50 latency (ms) | ${formatMetric(overall.cachedP50LatencyMs)} |
| Cached p95 latency (ms) | ${formatMetric(overall.cachedP95LatencyMs)} |

## Token-Overlap Grounding (report-only, NOT gated)

Bag-of-words overlap against the chunks that produced the answer. Kept for
continuity only: it measures whether the model quoted its own evidence, which
the system prompt instructs it to do, so it cannot detect an unsupported claim.
Abstentions are excluded rather than scored as perfectly grounded.

| Metric | Value |
| --- | ---: |
| Scored queries (abstentions excluded) | ${overall.groundedQueryCount} |
| Grounding score | ${overall.groundedQueryCount > 0 ? formatMetric(overall.groundingScore) : "n/a"} |
| Hallucination rate | ${overall.groundedQueryCount > 0 ? formatMetric(overall.hallucinationRate) : "n/a"} |

## LLM-Judge Metrics (faithfulness is gated; the rest are report-only)

Judge noise floor: ±${JUDGE_NOISE_FLOOR} (measured across two runs over
byte-identical retrieved chunks). Any judge-metric delta below this is
indistinguishable from run-to-run variance — do not read it as signal.
Limitations sections are stripped from answers before statement extraction:
their negative-existential claims ("the evidence does not establish X") can
never be "supported by the evidence" and previously biased faithfulness
downward for every answer.

| Metric | Value |
| --- | ---: |
| Judged queries | ${overall.judgedCount} |
| Faithfulness (GATED) | ${overall.judgedCount > 0 ? formatMetric(overall.faithfulness) : "n/a"} |
| Answer relevance | ${overall.judgedCount > 0 ? formatMetric(overall.answerRelevance) : "n/a"} |
| Context precision | ${overall.judgedCount > 0 ? formatMetric(overall.contextPrecision) : "n/a"} |
| Context recall | ${overall.judgedCount > 0 ? formatMetric(overall.contextRecall) : "n/a"} |
| Abstention rate | ${overall.judgedCount > 0 ? formatMetric(overall.abstentionRate) : "n/a"} |

## Threshold Gates

| Metric | Target | Actual | Status |
| --- | --- | ---: | --- |
${thresholdRows}

## Per-Language Breakdown

| Language | Queries | Recall@5 | nDCG@10 | Citation acc. | Faithfulness | Cache hit | Uncached p95 (ms) | Cached p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${languageRows}

## Open Risks

${openRisks.length === 0 ? "- No open risk items." : openRisks.map((item) => `- ${item}`).join("\n")}

## Failure Sample

| Query ID | Language | Failure types |
| --- | --- | --- |
${failureTableRows || "| none | n/a | n/a |"}

## Release Recommendation

${recommendation}
`;
}

function deriveScoreScaleComposition(
  chunks: RetrievedChunk[],
): ScoreScaleComposition {
  const scales = new Set(
    chunks.map((chunk) => chunk.scoreScale).filter(Boolean),
  );
  if (scales.size === 0) {
    return "unknown";
  }
  if (scales.size > 1) {
    return "mixed";
  }
  return scales.has("cross_encoder") ? "cross_encoder" : "heuristic";
}

async function evaluateQuery(
  args: RunnerArgs,
  query: EvaluationQueryRecord,
): Promise<QueryBenchmarkResult> {
  try {
    const execution =
      args.mode === "dry-run"
        ? executeDryRun(query, args.topK)
        : await executeLive(
            query,
            args.topK,
            args.expansion,
            args.cacheNamespace,
          );

    const retrievalMetrics = computeRetrievalMetrics(
      query,
      execution.uncached.chunks,
      { ignoreExpectedSection: args.ignoreExpectedSection },
    );
    const answerMetrics = computeAnswerMetrics(
      query,
      execution.uncached.answer,
      execution.uncached.citations,
      execution.uncached.chunks,
      execution.uncached.insufficientEvidence,
      execution.uncached.citationVerification,
    );
    const cacheHitOnRepeat = execution.cached.cacheHit;

    let judgeMetrics: QueryBenchmarkResult["judge"] = null;
    // Unanswerable queries are never judged: their only quality signal is the
    // production insufficientEvidence flag, and no judge dimension
    // (faithfulness, relevance, precision, recall) is consumed for them.
    if (
      args.judge &&
      args.mode === "live" &&
      query.question_type !== "unanswerable"
    ) {
      const deps = await loadLiveDependencies();
      judgeMetrics = await deps.judgeQueryResult({
        question: query.question,
        answer: execution.uncached.answer,
        insufficientEvidence: execution.uncached.insufficientEvidence,
        chunks: execution.uncached.chunks,
        acceptableAnswerPoints: query.acceptable_answer_points,
      });
    }

    return {
      id: query.id,
      language: query.language,
      question: query.question,
      questionType: query.question_type,
      retrieval: {
        cacheHit: execution.uncached.cacheHit,
        candidateCounts: execution.uncached.candidateCounts,
        chunks: execution.uncached.chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          documentId: chunk.documentId,
          pageNumber: chunk.pageNumber,
          sectionTitle: chunk.sectionTitle,
          source: chunk.source,
          retrievalScore: chunk.retrievalScore,
          rerankScore: chunk.rerankScore,
          relevanceScore: chunk.relevanceScore,
          scoreScale: chunk.scoreScale,
        })),
        scoreScaleComposition: deriveScoreScaleComposition(
          execution.uncached.chunks,
        ),
      },
      answer: {
        text: execution.uncached.answer,
        citations: execution.uncached.citations,
        insufficientEvidence: execution.uncached.insufficientEvidence,
        truncated: execution.uncached.answerTruncated,
      },
      metrics: {
        ...retrievalMetrics,
        ...answerMetrics,
        uncachedLatencyMs: execution.uncached.latencyMs,
        cachedLatencyMs: execution.cached.latencyMs,
        cacheHitOnRepeat,
      },
      judge: judgeMetrics,
      failures: deriveFailures(
        query,
        retrievalMetrics,
        answerMetrics,
        judgeMetrics,
        execution.uncached.insufficientEvidence,
        execution.uncached.latencyMs,
        execution.cached.latencyMs,
        cacheHitOnRepeat,
      ),
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return {
      id: query.id,
      language: query.language,
      question: query.question,
      questionType: query.question_type,
      retrieval: {
        cacheHit: false,
        candidateCounts: {
          vector: 0,
          keyword: 0,
          fused: 0,
          reranked: 0,
        },
        chunks: [],
        scoreScaleComposition: "unknown",
      },
      answer: {
        text: "",
        citations: [],
        insufficientEvidence: false,
        truncated: false,
      },
      metrics: {
        recallAt5: 0,
        ndcgAt10: 0,
        mrr: 0,
        firstRelevantRank: null,
        relevantRanks: [],
        citationAccuracy: 0,
        citationEvidenceHit: 0,
        verifiedCitationRate: null,
        groundingScore: 0,
        hallucinationRate: 1,
        uncachedLatencyMs: 0,
        cachedLatencyMs: 0,
        cacheHitOnRepeat: false,
      },
      judge: null,
      failures: [
        {
          failureType: "system_error",
          probableRootCause: message,
          remediationTicket: `TODO-EVAL-${query.id}`,
        },
      ],
      error: message,
    };
  }
}

/**
 * `faithfulness` is a release gate, so the judge must not be the generator.
 * A judge sharing the generator's weights grades its own phrasing habits as
 * correct, and the gate then certifies self-consistency rather than grounding.
 */
async function assertJudgePreflight(): Promise<void> {
  const { env } = await loadLiveDependencies();
  const generator = env.RAG_LLM_MODEL;
  const judge = env.RAG_EVAL_JUDGE_MODEL;

  console.log(`Generator model: ${generator}`);
  console.log(`Judge model:     ${judge}`);

  if (generator === judge) {
    throw new Error(
      `RAG_EVAL_JUDGE_MODEL must differ from RAG_LLM_MODEL (both are "${judge}"). ` +
        "Set a judge from a different model family, or pass --no-judge to run without gated faithfulness.",
    );
  }

  if (judge.startsWith("claude") && !env.ANTHROPIC_API_KEY) {
    throw new Error(
      `RAG_EVAL_JUDGE_MODEL is "${judge}" but ANTHROPIC_API_KEY is not configured.`,
    );
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv);
  const resolvedDatasetPath = path.resolve(args.datasetPath);

  if (!fs.existsSync(resolvedDatasetPath)) {
    throw new Error(`Dataset file not found: ${resolvedDatasetPath}`);
  }

  const rawDataset = JSON.parse(
    fs.readFileSync(resolvedDatasetPath, "utf8"),
  ) as unknown;
  // Floors sized to a corpus-derived golden set (the corpus's real languages),
  // not the old 200-record synthetic fixture, which is gone.
  const validated = validateEvaluationDataset(rawDataset, {
    minTotalQueries: 25,
    minPerLanguage: 5,
  });
  const selectedRecords = selectRecords(validated.records, args);

  if (selectedRecords.length === 0) {
    throw new Error("No evaluation queries selected after applying filters.");
  }

  if (args.mode === "live") {
    try {
      await loadLiveDependencies();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Live benchmark preflight failed. Ensure staging env vars are configured (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY). ${message}`,
      );
    }

    // Refuse to measure against a corpus the golden set no longer describes.
    // A silent mismatch previously read as a retrieval collapse (recall 0.405
    // on the 2026-08-04 run) that never happened.
    const [{ getSupabaseAdminClient }, { computeCorpusFingerprint }] =
      await Promise.all([
        import("../../lib/supabase/admin"),
        import("../../lib/evaluation/corpus-fingerprint"),
      ]);
    const liveFingerprint = await computeCorpusFingerprint(
      getSupabaseAdminClient(),
    );
    if (liveFingerprint !== validated.corpusFingerprint) {
      throw new Error(
        `Corpus fingerprint mismatch: dataset was generated against ` +
          `${validated.corpusFingerprint} but the live corpus is ${liveFingerprint}. ` +
          `The corpus has been re-ingested or edited since the golden set was ` +
          `built — regenerate it with \`npm run eval:dataset:corpus\` before ` +
          `benchmarking.`,
      );
    }

    if (args.judge) {
      await assertJudgePreflight();
    }
  }

  console.log(
    `Running benchmark in mode=${args.mode} with ${selectedRecords.length} queries...`,
  );
  const results: QueryBenchmarkResult[] = [];

  for (let index = 0; index < selectedRecords.length; index += 1) {
    const query = selectedRecords[index];
    if (!query) {
      continue;
    }
    const result = await evaluateQuery(args, query);
    results.push(result);

    if ((index + 1) % 10 === 0 || index === selectedRecords.length - 1) {
      console.log(`Processed ${index + 1}/${selectedRecords.length} queries`);
    }
  }

  const summary = summarizeBenchmark(results);
  const thresholdEvaluation = evaluateThresholds(
    summary.overall,
    DEFAULT_BENCHMARK_THRESHOLDS,
    summary.byLanguage,
  );

  const generatedAt = new Date().toISOString();
  const timestamp = generatedAt.replace(/[:.]/g, "-");
  const reportsDir = path.resolve(args.reportsDir);
  const runsDir = path.resolve(args.runsDir);

  fs.mkdirSync(reportsDir, { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });

  const runArtifact = {
    generatedAt,
    mode: args.mode,
    datasetPath: resolvedDatasetPath,
    dataset: {
      corpusFingerprint: validated.corpusFingerprint,
      generatedAt: validated.generatedAt,
      generatorModel: validated.generatorModel,
      answerableCount: validated.answerableCount,
      unanswerableCount: validated.unanswerableCount,
    },
    queryCount: selectedRecords.length,
    // Judge deltas below this are indistinguishable from run-to-run variance.
    judgeNoiseFloor: JUDGE_NOISE_FLOOR,
    config: await buildRunConfig(args),
    thresholds: DEFAULT_BENCHMARK_THRESHOLDS,
    summary,
    thresholdEvaluation,
    results,
  };

  const runPath = path.join(runsDir, `benchmark-${timestamp}.json`);
  // A dry run fabricates chunks that always contain the expected page (recall
  // 1.000, grounding 1.000). Writing that to latest.json made it eligible as
  // release-gate input, so dry runs get their own filename and the release
  // readiness gate only ever reads a live artifact.
  const latestRunPath = path.join(
    runsDir,
    args.mode === "dry-run" ? "latest-dry-run.json" : "latest.json",
  );
  fs.writeFileSync(
    runPath,
    `${JSON.stringify(runArtifact, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    latestRunPath,
    `${JSON.stringify(runArtifact, null, 2)}\n`,
    "utf8",
  );

  const reportMarkdown = buildMarkdownReport({
    mode: args.mode,
    datasetPath: args.datasetPath,
    runPath,
    generatedAt,
    queryCount: selectedRecords.length,
    corpusFingerprint: validated.corpusFingerprint,
    config: runArtifact.config,
    summary,
    thresholdEvaluation,
    results,
  });

  const reportPath = path.join(reportsDir, `benchmark-${timestamp}.md`);
  const latestReportPath = path.join(
    reportsDir,
    args.mode === "dry-run" ? "latest-dry-run.md" : "latest.md",
  );
  fs.writeFileSync(reportPath, reportMarkdown, "utf8");
  fs.writeFileSync(latestReportPath, reportMarkdown, "utf8");

  console.log(`Run artifact: ${runPath}`);
  console.log(`Report: ${reportPath}`);
  console.log(`Gate status: ${thresholdEvaluation.passed ? "PASS" : "FAIL"}`);

  if (!thresholdEvaluation.passed && args.failOnGate) {
    process.exit(2);
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Benchmark runner failed: ${message}`);
  process.exit(1);
});
