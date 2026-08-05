import type {
  Citation,
  RetrievedChunk,
  SupportedLanguage,
} from "@/lib/contracts/retrieval";
import {
  DEFAULT_BENCHMARK_THRESHOLDS,
  EVALUATION_LANGUAGES,
  type BenchmarkSummaryMetrics,
  type BenchmarkThresholds,
  type QueryAnswerMetrics,
  type QueryBenchmarkResult,
  type QueryRetrievalMetrics,
  type ThresholdEvaluation,
  type ThresholdResult,
  type EvaluationQueryRecord,
} from "@/lib/evaluation/types";

const INSUFFICIENT_EVIDENCE_PATTERNS: RegExp[] = [
  /not enough evidence/i,
  /insufficient evidence/i,
  /nicht genug belege/i,
  /preuves insuffisantes/i,
  /prove insufficienti/i,
  /evidencia insuficiente/i,
];

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(input: string): string[] {
  return normalizeText(input)
    .split(/[^a-z0-9\u00c0-\u024f]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function computePercentile(values: number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

/**
 * Options for relevance judging.
 *
 * `ignoreExpectedSection` exists for one narrow purpose: A/B-ing a change that
 * alters `section_title`. The golden set stores today's section labels, several
 * of them mangled by the extraction bug item 2.1 fixes (`Mandat ZüRich`,
 * `Pacity Building`), so any run after that fix fails the substring match on 26
 * of 44 records and reads as a retrieval collapse that did not happen. Page
 * numbers survive a re-chunk; section titles do not.
 *
 * It must be applied to *both* arms of a comparison, and it must default off —
 * release gates are judged on the strict definition.
 */
export type RelevanceOptions = {
  ignoreExpectedSection?: boolean;
};

export function isChunkRelevant(
  record: EvaluationQueryRecord,
  chunk: Pick<RetrievedChunk, "documentId" | "pageNumber" | "sectionTitle">,
  options: RelevanceOptions = {},
): boolean {
  if (chunk.documentId !== record.expected_document) {
    return false;
  }

  if (!record.expected_pages.includes(chunk.pageNumber)) {
    return false;
  }

  if (options.ignoreExpectedSection) {
    return true;
  }

  const expectedSection = normalizeText(record.expected_section);
  const observedSection = normalizeText(chunk.sectionTitle ?? "");
  if (!expectedSection || !observedSection) {
    return true;
  }

  return (
    observedSection.includes(expectedSection) ||
    expectedSection.includes(observedSection)
  );
}

export function computeRetrievalMetrics(
  record: EvaluationQueryRecord,
  chunks: RetrievedChunk[],
  options: RelevanceOptions = {},
): QueryRetrievalMetrics {
  const top10 = chunks.slice(0, 10);
  const relevantRanks: number[] = [];

  for (let index = 0; index < top10.length; index += 1) {
    const chunk = top10[index];
    if (!chunk) {
      continue;
    }
    if (isChunkRelevant(record, chunk, options)) {
      relevantRanks.push(index + 1);
    }
  }

  const recallAt5 = relevantRanks.some((rank) => rank <= 5) ? 1 : 0;
  const firstRelevantRank = relevantRanks[0] ?? null;
  const mrr = firstRelevantRank ? 1 / firstRelevantRank : 0;

  let dcg = 0;
  for (let index = 0; index < top10.length; index += 1) {
    const chunk = top10[index];
    if (!chunk) {
      continue;
    }
    const relevance = isChunkRelevant(record, chunk, options) ? 1 : 0;
    if (relevance > 0) {
      dcg += (2 ** relevance - 1) / Math.log2(index + 2);
    }
  }

  // The ideal ranking must account for every relevant chunk actually found,
  // not just one per expected page: several chunks from the same expected page
  // each score in DCG, and normalising by expected_pages.length alone produced
  // nDCG values above 1.
  const expectedRelevantCount = Math.max(
    1,
    record.expected_pages.length,
    relevantRanks.length,
  );
  let idcg = 0;
  for (let index = 0; index < Math.min(expectedRelevantCount, 10); index += 1) {
    idcg += 1 / Math.log2(index + 2);
  }

  return {
    recallAt5,
    ndcgAt10: idcg > 0 ? dcg / idcg : 0,
    mrr,
    firstRelevantRank,
    relevantRanks,
  };
}

export function computeCitationAccuracy(
  record: EvaluationQueryRecord,
  citations: Citation[],
): number {
  if (citations.length === 0) {
    return 0;
  }

  const matches = citations.filter(
    (citation) =>
      citation.documentId === record.expected_document &&
      record.expected_pages.includes(citation.pageNumber),
  ).length;

  return matches / citations.length;
}

/**
 * 1 when any citation points to the golden evidence (expected document +
 * expected page). Unlike the strict accuracy above, an answer that also
 * cites additional supporting chunks — legitimate multi-chunk synthesis —
 * is not penalised for it.
 */
export function computeCitationEvidenceHit(
  record: EvaluationQueryRecord,
  citations: Citation[],
): number {
  return citations.some(
    (citation) =>
      citation.documentId === record.expected_document &&
      record.expected_pages.includes(citation.pageNumber),
  )
    ? 1
    : 0;
}

function splitStatements(answer: string): string[] {
  return answer
    .split(/(?<=[.!?])\s+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function hasInsufficientEvidenceSignal(answer: string): boolean {
  return INSUFFICIENT_EVIDENCE_PATTERNS.some((pattern) => pattern.test(answer));
}

function buildCorpusTokenSet(
  chunks: RetrievedChunk[],
  acceptableAnswerPoints: string[],
): Set<string> {
  const tokenSet = new Set<string>();
  const corpus = [
    ...chunks.map(
      (chunk) => `${chunk.sectionTitle} ${chunk.context} ${chunk.content}`,
    ),
    ...acceptableAnswerPoints,
  ];

  for (const item of corpus) {
    for (const token of tokenize(item)) {
      tokenSet.add(token);
    }
  }

  return tokenSet;
}

function isStatementSupported(
  statement: string,
  acceptableAnswerPoints: string[],
  corpusTokens: Set<string>,
): boolean {
  const normalizedStatement = normalizeText(statement);
  for (const point of acceptableAnswerPoints) {
    const normalizedPoint = normalizeText(point);
    if (!normalizedPoint) {
      continue;
    }
    if (
      normalizedStatement.includes(normalizedPoint) ||
      normalizedPoint.includes(normalizedStatement)
    ) {
      return true;
    }
  }

  const statementTokens = tokenize(statement);
  if (statementTokens.length === 0) {
    return true;
  }

  let overlap = 0;
  for (const token of statementTokens) {
    if (corpusTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / statementTokens.length >= 0.35;
}

export function computeAnswerMetrics(
  record: EvaluationQueryRecord,
  answer: string,
  citations: Citation[],
  chunks: RetrievedChunk[],
  insufficientEvidence: boolean,
  verification?: {
    checkedCount: number;
    supportedCount: number;
    unverified: boolean;
  } | null,
): QueryAnswerMetrics {
  const citationAccuracy = computeCitationAccuracy(record, citations);
  const citationEvidenceHit = computeCitationEvidenceHit(record, citations);
  // Content-level citation quality from the production verifier. Null (and
  // excluded from averages) when verification did not run or no sentence
  // carried a marker — a failed verifier must not read as a perfect score.
  const verifiedCitationRate =
    verification && !verification.unverified && verification.checkedCount > 0
      ? verification.supportedCount / verification.checkedCount
      : null;

  // An abstention makes no claims, so it has no grounding score to give.
  // Returning 1/0 here was the single largest contributor to a hallucination
  // rate that could not fail: every refusal scored as perfectly grounded.
  if (insufficientEvidence || hasInsufficientEvidenceSignal(answer)) {
    return {
      citationAccuracy,
      citationEvidenceHit,
      verifiedCitationRate,
      groundingScore: null,
      hallucinationRate: null,
    };
  }

  const statements = splitStatements(answer);
  if (statements.length === 0) {
    return {
      citationAccuracy,
      citationEvidenceHit,
      verifiedCitationRate,
      groundingScore: 0,
      hallucinationRate: 1,
    };
  }

  const corpusTokens = buildCorpusTokenSet(
    chunks,
    record.acceptable_answer_points,
  );
  const supported = statements.filter((statement) =>
    isStatementSupported(
      statement,
      record.acceptable_answer_points,
      corpusTokens,
    ),
  ).length;

  const groundingScore = supported / statements.length;

  return {
    citationAccuracy,
    citationEvidenceHit,
    verifiedCitationRate,
    groundingScore,
    hallucinationRate: 1 - groundingScore,
  };
}

function initLanguageBuckets(): Record<
  SupportedLanguage,
  QueryBenchmarkResult[]
> {
  return {
    EN: [],
    DE: [],
    FR: [],
    IT: [],
    ES: [],
  };
}

export function summarizeBenchmark(results: QueryBenchmarkResult[]): {
  overall: BenchmarkSummaryMetrics;
  byLanguage: Record<SupportedLanguage, BenchmarkSummaryMetrics>;
} {
  const byLanguageBuckets = initLanguageBuckets();
  for (const result of results) {
    byLanguageBuckets[result.language].push(result);
  }

  return {
    overall: summarizeBucket(results),
    byLanguage: {
      EN: summarizeBucket(byLanguageBuckets.EN),
      DE: summarizeBucket(byLanguageBuckets.DE),
      FR: summarizeBucket(byLanguageBuckets.FR),
      IT: summarizeBucket(byLanguageBuckets.IT),
      ES: summarizeBucket(byLanguageBuckets.ES),
    },
  };
}

function summarizeBucket(
  results: QueryBenchmarkResult[],
): BenchmarkSummaryMetrics {
  const evaluated = results.filter((result) => !result.error);
  const systemErrorCount = results.length - evaluated.length;

  const recallValues = evaluated.map((result) => result.metrics.recallAt5);
  const ndcgValues = evaluated.map((result) => result.metrics.ndcgAt10);
  const mrrValues = evaluated.map((result) => result.metrics.mrr);
  const citationValues = evaluated.map(
    (result) => result.metrics.citationAccuracy,
  );
  // Abstentions carry null and are excluded rather than averaged as perfect.
  const groundingValues = evaluated
    .map((result) => result.metrics.groundingScore)
    .filter((value): value is number => value !== null);
  const hallucinationValues = evaluated
    .map((result) => result.metrics.hallucinationRate)
    .filter((value): value is number => value !== null);
  const cacheHitValues = evaluated.map((result) =>
    result.metrics.cacheHitOnRepeat ? 1 : 0,
  );
  const uncachedLatencies = evaluated.map(
    (result) => result.metrics.uncachedLatencyMs,
  );
  const cachedLatencies = evaluated.map(
    (result) => result.metrics.cachedLatencyMs,
  );
  const evidenceHitValues = evaluated.map(
    (result) => result.metrics.citationEvidenceHit,
  );
  // Verified-citation averages run over queries where the verifier produced
  // verdicts; failed/absent verification excludes the query rather than
  // silently scoring it perfect.
  const verifiedRates = evaluated
    .map((result) => result.metrics.verifiedCitationRate)
    .filter((value): value is number => value !== null);

  // Judge averages run over successfully judged queries only; a failed judge
  // call excludes the query from the average instead of scoring it perfect.
  const judged = evaluated.filter((result) => result.judge?.judged);
  const judgeAverage = (
    pick: (judge: NonNullable<QueryBenchmarkResult["judge"]>) => number | null,
  ): number =>
    average(
      judged
        .map((result) => pick(result.judge!))
        .filter((value): value is number => value !== null),
    );

  return {
    queryCount: results.length,
    evaluatedCount: evaluated.length,
    systemErrorCount,
    recallAt5: average(recallValues),
    ndcgAt10: average(ndcgValues),
    mrr: average(mrrValues),
    citationAccuracy: average(citationValues),
    groundingScore: average(groundingValues),
    hallucinationRate: average(hallucinationValues),
    groundedQueryCount: groundingValues.length,
    cacheHitRate: average(cacheHitValues),
    uncachedP50LatencyMs: computePercentile(uncachedLatencies, 50),
    uncachedP95LatencyMs: computePercentile(uncachedLatencies, 95),
    cachedP50LatencyMs: computePercentile(cachedLatencies, 50),
    cachedP95LatencyMs: computePercentile(cachedLatencies, 95),
    systemErrorRate: results.length > 0 ? systemErrorCount / results.length : 0,
    citationEvidenceHitRate: average(evidenceHitValues),
    verifiedCitationRate: average(verifiedRates),
    verifiedQueryCount: verifiedRates.length,
    judgedCount: judged.length,
    faithfulness: judgeAverage((judge) => judge.faithfulness),
    answerRelevance: judgeAverage((judge) => judge.answerRelevance),
    contextPrecision: judgeAverage((judge) => judge.contextPrecision),
    contextRecall: judgeAverage((judge) => judge.contextRecall),
    abstentionRate:
      judged.length > 0
        ? judged.filter((result) => result.judge?.abstained).length /
          judged.length
        : 0,
    truncationRate:
      results.length > 0
        ? results.filter((result) => result.answer.truncated).length /
          results.length
        : 0,
  };
}

function thresholdChecks(
  summary: BenchmarkSummaryMetrics,
  thresholds: BenchmarkThresholds,
): ThresholdResult[] {
  return [
    {
      metric: "Recall@5",
      actual: summary.recallAt5,
      target: `>= ${thresholds.recallAt5}`,
      passed: summary.recallAt5 >= thresholds.recallAt5,
    },
    {
      metric: "nDCG@10",
      actual: summary.ndcgAt10,
      target: `>= ${thresholds.ndcgAt10}`,
      passed: summary.ndcgAt10 >= thresholds.ndcgAt10,
    },
    {
      metric: "Citation evidence hit rate",
      actual: summary.citationEvidenceHitRate,
      target: `>= ${thresholds.citationEvidenceHitRate}`,
      passed:
        summary.citationEvidenceHitRate >= thresholds.citationEvidenceHitRate,
    },
    {
      metric: "Verified citation rate",
      actual: summary.verifiedCitationRate,
      target: `>= ${thresholds.verifiedCitationRate}`,
      // A run with zero verified queries must fail this gate loudly rather
      // than pass on an empty average.
      passed:
        summary.verifiedQueryCount > 0 &&
        summary.verifiedCitationRate >= thresholds.verifiedCitationRate,
    },
    {
      // Replaces the bag-of-words "Hallucination rate" gate, which measured
      // 35% token overlap between the answer and the very chunks that produced
      // it, against a prompt instructing the model to quote those chunks. It
      // was structurally incapable of failing; it is now report-only.
      metric: "Faithfulness (LLM judge)",
      actual: summary.faithfulness,
      target: `>= ${thresholds.faithfulnessMin}`,
      // A run with zero judged queries fails loudly rather than passing on an
      // empty average -- same fail-closed pattern as verifiedCitationRate.
      passed:
        summary.judgedCount > 0 &&
        summary.faithfulness >= thresholds.faithfulnessMin,
    },
    {
      metric: "Cache hit rate",
      actual: summary.cacheHitRate,
      target: `>= ${thresholds.cacheHitRate}`,
      passed: summary.cacheHitRate >= thresholds.cacheHitRate,
    },
    {
      metric: "Uncached p50 latency (ms)",
      actual: summary.uncachedP50LatencyMs,
      target: `< ${thresholds.uncachedP50LatencyMs}`,
      passed: summary.uncachedP50LatencyMs < thresholds.uncachedP50LatencyMs,
    },
    {
      metric: "Uncached p95 latency (ms)",
      actual: summary.uncachedP95LatencyMs,
      target: `< ${thresholds.uncachedP95LatencyMs}`,
      passed: summary.uncachedP95LatencyMs < thresholds.uncachedP95LatencyMs,
    },
    {
      metric: "Cached p50 latency (ms)",
      actual: summary.cachedP50LatencyMs,
      target: `< ${thresholds.cachedP50LatencyMs}`,
      passed: summary.cachedP50LatencyMs < thresholds.cachedP50LatencyMs,
    },
    {
      metric: "Cached p95 latency (ms)",
      actual: summary.cachedP95LatencyMs,
      target: `< ${thresholds.cachedP95LatencyMs}`,
      passed: summary.cachedP95LatencyMs < thresholds.cachedP95LatencyMs,
    },
  ];
}

export function evaluateThresholds(
  summary: BenchmarkSummaryMetrics,
  thresholds: BenchmarkThresholds = DEFAULT_BENCHMARK_THRESHOLDS,
): ThresholdEvaluation {
  const checks = thresholdChecks(summary, thresholds);
  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
}

export function formatMetric(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(4);
}

export function languageOrder(): SupportedLanguage[] {
  return [...EVALUATION_LANGUAGES];
}
