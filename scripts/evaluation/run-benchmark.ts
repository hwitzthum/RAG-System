#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import type { Citation, RetrievedChunk, SupportedLanguage } from "../../lib/contracts/retrieval";
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
  type EvaluationQueryRecord,
  type QueryBenchmarkResult,
  type QueryFailure,
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
};

type QueryExecution = {
  uncached: RunCapture;
  cached: RunCapture;
};

type LiveDependencies = {
  retrieveRankedCandidates: typeof import("../../lib/retrieval/service").retrieveRankedCandidates;
  generateGroundedAnswer: typeof import("../../lib/answering/service").generateGroundedAnswer;
  env: typeof import("../../lib/config/env").env;
};

let liveDependenciesPromise: Promise<LiveDependencies> | null = null;

async function loadLiveDependencies(): Promise<LiveDependencies> {
  if (!liveDependenciesPromise) {
    liveDependenciesPromise = Promise.all([
      import("../../lib/retrieval/service"),
      import("../../lib/answering/service"),
      import("../../lib/config/env"),
    ]).then(([retrievalModule, answerModule, envModule]) => ({
      retrieveRankedCandidates: retrievalModule.retrieveRankedCandidates,
      generateGroundedAnswer: answerModule.generateGroundedAnswer,
      env: envModule.env,
    }));
  }

  return liveDependenciesPromise;
}

function parseArgs(argv: string[]): RunnerArgs {
  const args: RunnerArgs = {
    datasetPath: "evaluation/evaluation_queries.json",
    reportsDir: "evaluation/reports",
    runsDir: "evaluation/runs",
    mode: "live",
    topK: 8,
    sampleSize: null,
    languages: null,
    failOnGate: true,
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
        .filter((value): value is SupportedLanguage => ["EN", "DE", "FR", "IT", "ES"].includes(value));
      args.languages = parsed.length > 0 ? parsed : null;
      index += 1;
    } else if (token === "--no-fail-on-gate") {
      args.failOnGate = false;
    }
  }

  return args;
}

function selectRecords(records: EvaluationQueryRecord[], args: RunnerArgs): EvaluationQueryRecord[] {
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
  const chunkId = isRelevant ? `${query.id}-rel-${rank}` : `${query.id}-noise-${rank}`;
  return {
    chunkId,
    documentId: isRelevant ? query.expected_document : `noise_doc_${rank}`,
    pageNumber: isRelevant ? relevantPage ?? query.expected_pages[0] ?? 1 : rank + 40,
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

function executeDryRun(query: EvaluationQueryRecord, topK: number): QueryExecution {
  const language = query.language;
  const uncachedLatencyMs = deterministicNumber(`${query.id}:uncached`, 900, 1900);
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

  const answerText = `${query.acceptable_answer_points[0]}. ${query.acceptable_answer_points[1]}. ${query.acceptable_answer_points[2]}.`;
  const citations: Citation[] = [
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
      insufficientEvidence: false,
      latencyMs: uncachedLatencyMs,
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
      insufficientEvidence: false,
      latencyMs: cachedLatencyMs,
    },
  };
}

async function executeLive(query: EvaluationQueryRecord, topK: number): Promise<QueryExecution> {
  const deps = await loadLiveDependencies();

  const uncachedStart = Date.now();
  const uncachedRetrieval = await deps.retrieveRankedCandidates({
    query: query.question,
    topK,
    languageHint: query.language,
  }, {
    // Force cache bypass for the first run to measure true uncached retrieval latency.
    readCache: async () => null,
  });
  const uncachedAnswer = await deps.generateGroundedAnswer({
    query: query.question,
    language: uncachedRetrieval.trace.language,
    chunks: uncachedRetrieval.chunks,
    minEvidenceChunks: deps.env.RAG_MIN_EVIDENCE_CHUNKS,
    minRerankScore: deps.env.RAG_MIN_RERANK_SCORE,
    maxOutputTokens: deps.env.RAG_LLM_MAX_OUTPUT_TOKENS,
  });
  const uncachedLatencyMs = Date.now() - uncachedStart;

  const cachedStart = Date.now();
  const cachedRetrieval = await deps.retrieveRankedCandidates({
    query: query.question,
    topK,
    languageHint: query.language,
  });
  const cachedAnswer = await deps.generateGroundedAnswer({
    query: query.question,
    language: cachedRetrieval.trace.language,
    chunks: cachedRetrieval.chunks,
    minEvidenceChunks: deps.env.RAG_MIN_EVIDENCE_CHUNKS,
    minRerankScore: deps.env.RAG_MIN_RERANK_SCORE,
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
    },
    cached: {
      chunks: cachedRetrieval.chunks,
      candidateCounts: cachedRetrieval.trace.candidateCounts,
      cacheHit: cachedRetrieval.trace.cacheHit,
      answer: cachedAnswer.answer,
      citations: cachedAnswer.citations,
      insufficientEvidence: cachedAnswer.insufficientEvidence,
      latencyMs: cachedLatencyMs,
    },
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
  queryId: string,
  retrievalMetrics: ReturnType<typeof computeRetrievalMetrics>,
  answerMetrics: ReturnType<typeof computeAnswerMetrics>,
  uncachedLatencyMs: number,
  cachedLatencyMs: number,
  cacheHitOnRepeat: boolean,
): QueryFailure[] {
  const failures: QueryFailure[] = [];

  if (retrievalMetrics.recallAt5 < 1) {
    failures.push(
      toFailure("retrieval", "Expected evidence was not retrieved within top-5 ranked chunks.", queryId),
    );
  }

  if (answerMetrics.citationAccuracy < 1) {
    failures.push(
      toFailure("citation", "Citations did not consistently point to expected document/page evidence.", queryId),
    );
  }

  if (answerMetrics.hallucinationRate > DEFAULT_BENCHMARK_THRESHOLDS.hallucinationRateMax) {
    failures.push(
      toFailure("grounding", "Answer statements were insufficiently supported by retrieved evidence.", queryId),
    );
  }

  if (
    uncachedLatencyMs >= DEFAULT_BENCHMARK_THRESHOLDS.uncachedP95LatencyMs ||
    cachedLatencyMs >= DEFAULT_BENCHMARK_THRESHOLDS.cachedP95LatencyMs
  ) {
    failures.push(
      toFailure("latency", "Query latency exceeded release threshold for cached or uncached execution.", queryId),
    );
  }

  if (!cacheHitOnRepeat) {
    failures.push(
      toFailure("cache", "Repeated query did not hit retrieval cache with same retrieval version/key inputs.", queryId),
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
  summary: ReturnType<typeof summarizeBenchmark>;
  thresholdEvaluation: ReturnType<typeof evaluateThresholds>;
  results: QueryBenchmarkResult[];
}): string {
  const overall = input.summary.overall;
  const languageRows = languageOrder()
    .map((language) => {
      const metrics = input.summary.byLanguage[language];
      return `| ${language} | ${metrics.queryCount} | ${formatMetric(metrics.recallAt5)} | ${formatMetric(metrics.ndcgAt10)} | ${formatMetric(metrics.citationAccuracy)} | ${formatMetric(metrics.hallucinationRate)} | ${formatMetric(metrics.cacheHitRate)} | ${formatMetric(metrics.uncachedP95LatencyMs)} | ${formatMetric(metrics.cachedP95LatencyMs)} |`;
    })
    .join("\n");

  const thresholdRows = input.thresholdEvaluation.checks
    .map((check) => `| ${check.metric} | ${check.target} | ${formatMetric(check.actual)} | ${check.passed ? "PASS" : "FAIL"} |`)
    .join("\n");

  const failedQueries = input.results.filter((result) => result.failures.length > 0 || result.error);
  const openRisks = [
    ...input.thresholdEvaluation.checks
      .filter((check) => !check.passed)
      .map((check) => `${check.metric} gate failed (actual ${formatMetric(check.actual)}, target ${check.target}).`),
    ...(overall.systemErrorCount > 0
      ? [`System errors detected for ${overall.systemErrorCount} queries (${formatMetric(overall.systemErrorRate)} rate).`]
      : []),
    ...(failedQueries.length > 0
      ? [`${failedQueries.length} queries include at least one failure type requiring triage.`]
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

  return `# Phase 11 Benchmark Report

Generated: ${input.generatedAt}
Mode: ${input.mode}
Dataset: ${path.resolve(input.datasetPath)}
Run artifact: ${path.resolve(input.runPath)}
Evaluated queries: ${input.queryCount}

## Summary

| Metric | Value |
| --- | ---: |
| Query count | ${overall.queryCount} |
| Evaluated queries | ${overall.evaluatedCount} |
| System error count | ${overall.systemErrorCount} |
| Recall@5 | ${formatMetric(overall.recallAt5)} |
| nDCG@10 | ${formatMetric(overall.ndcgAt10)} |
| MRR | ${formatMetric(overall.mrr)} |
| Citation accuracy | ${formatMetric(overall.citationAccuracy)} |
| Grounding score | ${formatMetric(overall.groundingScore)} |
| Hallucination rate | ${formatMetric(overall.hallucinationRate)} |
| Cache hit rate | ${formatMetric(overall.cacheHitRate)} |
| Uncached p50 latency (ms) | ${formatMetric(overall.uncachedP50LatencyMs)} |
| Uncached p95 latency (ms) | ${formatMetric(overall.uncachedP95LatencyMs)} |
| Cached p50 latency (ms) | ${formatMetric(overall.cachedP50LatencyMs)} |
| Cached p95 latency (ms) | ${formatMetric(overall.cachedP95LatencyMs)} |

## Threshold Gates

| Metric | Target | Actual | Status |
| --- | --- | ---: | --- |
${thresholdRows}

## Per-Language Breakdown

| Language | Queries | Recall@5 | nDCG@10 | Citation acc. | Hallucination | Cache hit | Uncached p95 (ms) | Cached p95 (ms) |
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

async function evaluateQuery(args: RunnerArgs, query: EvaluationQueryRecord): Promise<QueryBenchmarkResult> {
  try {
    const execution = args.mode === "dry-run" ? executeDryRun(query, args.topK) : await executeLive(query, args.topK);

    const retrievalMetrics = computeRetrievalMetrics(query, execution.uncached.chunks);
    const answerMetrics = computeAnswerMetrics(
      query,
      execution.uncached.answer,
      execution.uncached.citations,
      execution.uncached.chunks,
      execution.uncached.insufficientEvidence,
    );
    const cacheHitOnRepeat = execution.cached.cacheHit;

    return {
      id: query.id,
      language: query.language,
      question: query.question,
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
        })),
      },
      answer: {
        text: execution.uncached.answer,
        citations: execution.uncached.citations,
        insufficientEvidence: execution.uncached.insufficientEvidence,
      },
      metrics: {
        ...retrievalMetrics,
        ...answerMetrics,
        uncachedLatencyMs: execution.uncached.latencyMs,
        cachedLatencyMs: execution.cached.latencyMs,
        cacheHitOnRepeat,
      },
      failures: deriveFailures(
        query.id,
        retrievalMetrics,
        answerMetrics,
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
      retrieval: {
        cacheHit: false,
        candidateCounts: {
          vector: 0,
          keyword: 0,
          fused: 0,
          reranked: 0,
        },
        chunks: [],
      },
      answer: {
        text: "",
        citations: [],
        insufficientEvidence: false,
      },
      metrics: {
        recallAt5: 0,
        ndcgAt10: 0,
        mrr: 0,
        firstRelevantRank: null,
        relevantRanks: [],
        citationAccuracy: 0,
        groundingScore: 0,
        hallucinationRate: 1,
        uncachedLatencyMs: 0,
        cachedLatencyMs: 0,
        cacheHitOnRepeat: false,
      },
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

async function run(): Promise<void> {
  const args = parseArgs(process.argv);
  const resolvedDatasetPath = path.resolve(args.datasetPath);

  if (!fs.existsSync(resolvedDatasetPath)) {
    throw new Error(`Dataset file not found: ${resolvedDatasetPath}`);
  }

  const rawDataset = JSON.parse(fs.readFileSync(resolvedDatasetPath, "utf8")) as unknown;
  const validated = validateEvaluationDataset(rawDataset);
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
  }

  console.log(`Running benchmark in mode=${args.mode} with ${selectedRecords.length} queries...`);
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
  const thresholdEvaluation = evaluateThresholds(summary.overall, DEFAULT_BENCHMARK_THRESHOLDS);

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
    queryCount: selectedRecords.length,
    thresholds: DEFAULT_BENCHMARK_THRESHOLDS,
    summary,
    thresholdEvaluation,
    results,
  };

  const runPath = path.join(runsDir, `benchmark-${timestamp}.json`);
  const latestRunPath = path.join(runsDir, "latest.json");
  fs.writeFileSync(runPath, `${JSON.stringify(runArtifact, null, 2)}\n`, "utf8");
  fs.writeFileSync(latestRunPath, `${JSON.stringify(runArtifact, null, 2)}\n`, "utf8");

  const reportMarkdown = buildMarkdownReport({
    mode: args.mode,
    datasetPath: args.datasetPath,
    runPath,
    generatedAt,
    queryCount: selectedRecords.length,
    summary,
    thresholdEvaluation,
    results,
  });

  const reportPath = path.join(reportsDir, `benchmark-${timestamp}.md`);
  const latestReportPath = path.join(reportsDir, "latest.md");
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
