import type {
  Citation,
  RetrievedChunk,
  SupportedLanguage,
} from "@/lib/contracts/retrieval";

export const EVALUATION_LANGUAGES = ["EN", "DE", "FR", "IT", "ES"] as const;

export type EvaluationLanguage = (typeof EVALUATION_LANGUAGES)[number];

export const EVALUATION_QUESTION_TYPES = [
  "single_hop",
  "multi_hop",
  "unanswerable",
  "adversarial",
] as const;

export type EvaluationQuestionType = (typeof EVALUATION_QUESTION_TYPES)[number];

export type EvaluationQueryRecord = {
  id: string;
  language: EvaluationLanguage;
  question: string;
  question_type: EvaluationQuestionType;
  /**
   * Exact ground truth: the chunk row(s) the question was generated from.
   * When non-empty, retrieval relevance is an exact chunk-id hit, replacing
   * the page-number proxy that scored the semantically correct passage one
   * page over as zero. Empty only for unanswerable questions.
   */
  expected_chunk_ids: string[];
  /** Empty string for unanswerable questions, which have no gold evidence. */
  expected_document: string;
  expected_section: string;
  expected_pages: number[];
  /** Empty for unanswerable questions: the correct behaviour is abstention. */
  acceptable_answer_points: string[];
};

/**
 * The dataset file wraps its records in an envelope binding them to the corpus
 * state they were generated from. A re-chunk previously invalidated the golden
 * set silently — benchmark-2026-08-04T11-28-14-544Z.json recorded recall 0.405
 * against stale ground truth, indistinguishable from a retrieval collapse.
 * The benchmark refuses to run when the live fingerprint no longer matches.
 */
export type EvaluationDatasetEnvelope = {
  corpusFingerprint: string;
  generatedAt: string;
  generatorModel: string;
  records: EvaluationQueryRecord[];
};

/**
 * Measured judge noise floor: two live runs over byte-identical retrieved
 * chunks differed by 0.0085 on contextPrecision (item 1.6 follow-up), so any
 * judge-metric delta under ~0.01 is indistinguishable from variance. Carried
 * into every report so deltas at the floor stop being read as signal.
 */
export const JUDGE_NOISE_FLOOR = 0.01;

export type DatasetValidationOptions = {
  minTotalQueries: number;
  minPerLanguage: number;
};

export type DatasetValidationResult = {
  corpusFingerprint: string;
  generatedAt: string;
  generatorModel: string;
  records: EvaluationQueryRecord[];
  totalQueries: number;
  answerableCount: number;
  unanswerableCount: number;
  languageCounts: Record<SupportedLanguage, number>;
};

export type QueryRetrievalMetrics = {
  recallAt5: number;
  ndcgAt10: number;
  mrr: number;
  firstRelevantRank: number | null;
  relevantRanks: number[];
};

export type QueryAnswerMetrics = {
  /**
   * Strict page-level accuracy (report-only, not gated): fraction of
   * citations matching the expected document AND page. Punishes legitimate
   * multi-chunk synthesis, so it is kept for continuity but no longer gates.
   */
  citationAccuracy: number;
  /**
   * 1 when at least one citation points to the golden evidence
   * (expected document + expected page): the answer cited its source.
   */
  citationEvidenceHit: number;
  /**
   * Fraction of [n]-cited sentences the production citation verifier judged
   * entailed by their cited chunks. Null when verification did not run or
   * no sentences carried markers; such queries are excluded from averages.
   */
  verifiedCitationRate: number | null;
  /**
   * Bag-of-words overlap against the chunks that produced the answer
   * (report-only, not gated). Null on abstention: an abstention makes no
   * claims, so scoring it 1.0 made a system that refused everything look
   * perfectly grounded. Null queries are excluded from the average.
   */
  groundingScore: number | null;
  hallucinationRate: number | null;
};

/**
 * LLM-as-judge metrics for a single query. `judged: false` means the judge
 * call failed or was disabled; numeric fields are then null and the query is
 * excluded from judge averages rather than silently scored as perfect.
 */
export type QueryJudgeMetrics = {
  judged: boolean;
  /** Fraction of answer statements supported by the retrieved evidence. */
  faithfulness: number | null;
  /** How directly the answer addresses the question (0-1). */
  answerRelevance: number | null;
  /** Fraction of retrieved chunks the judge deems relevant to the question. */
  contextPrecision: number | null;
  /** Fraction of acceptable answer points covered by the retrieved chunks. */
  contextRecall: number | null;
  /** The system abstained on a query the golden set considers answerable. */
  abstained: boolean;
  unsupportedStatementCount: number | null;
};

export type QueryLatencyMetrics = {
  uncachedLatencyMs: number;
  cachedLatencyMs: number;
};

export type BenchmarkThresholds = {
  recallAt5: number;
  ndcgAt10: number;
  citationEvidenceHitRate: number;
  verifiedCitationRate: number;
  /** LLM-judge statement-level entailment. Gated; see below. */
  faithfulnessMin: number;
  /** Report-only since the grounding metric was demoted. */
  hallucinationRateMax: number;
  /**
   * Max fraction of unanswerable questions the system answered instead of
   * abstaining on. Only checked when the dataset carries an unanswerable
   * slice; before item 3.1 abstention was structurally unmeasurable.
   */
  falseAnswerRateMax: number;
  /** Max fraction of answerable questions the system abstained on. */
  falseAbstentionRateMax: number;
  /**
   * Per-language floors for recall@5 / nDCG@10, applied to every language
   * with at least `perLanguageMinQueries` answerable queries. EN recall was
   * 0.667 while the 0.85 aggregate gate passed on DE's 1.000 — the aggregate
   * alone lets one language hide behind another.
   */
  perLanguageRecallAt5: number;
  perLanguageNdcgAt10: number;
  perLanguageMinQueries: number;
  cacheHitRate: number;
  uncachedP50LatencyMs: number;
  uncachedP95LatencyMs: number;
  cachedP50LatencyMs: number;
  cachedP95LatencyMs: number;
};

/**
 * Calibrated against the 2026-08-04 live benchmark on the re-ingested corpus
 * (44 corpus-grounded queries):
 *
 * - citationEvidenceHitRate measured 0.841 -> gate 0.80. Replaces the strict
 *   page-level citationAccuracy gate, which punished legitimate multi-chunk
 *   synthesis (any citation beyond the single golden page counted as wrong).
 * - verifiedCitationRate gates on the production citation verifier's
 *   per-sentence entailment verdicts -- a content-level citation check.
 * - Latency gates pair a TIGHT median with a WEATHER-TOLERANT p95. With ~40
 *   samples, p95 is decided by the 2-3 slowest upstream LLM calls, so a tight
 *   p95 gate flakes on transient provider slowness while the median stays
 *   rock-stable (measured p50 6.0-6.4s uncached / 5.2-5.4s cached across
 *   three live runs; p95 ranged 8.1-11.9s purely on upstream weather). The
 *   median gate catches systemic regressions; the p95 gate catches genuine
 *   tail blowups. Answer generation + citation verification are included in
 *   every measurement. The original 7000/2500 p95 values predated live
 *   measurement and were only ever "passed" by dry-run fabrications.
 */
export const DEFAULT_BENCHMARK_THRESHOLDS: BenchmarkThresholds = {
  recallAt5: 0.85,
  ndcgAt10: 0.8,
  citationEvidenceHitRate: 0.8,
  verifiedCitationRate: 0.9,
  // Set to match verifiedCitationRate rather than to the level the current
  // system happens to reach. The bag-of-words grounding metric it replaces
  // scored 0.000/0.000/0.000/0.004 across four live runs -- it could not fail.
  // Expect the first runs under a real NLI-style judge to fail while the true
  // faithfulness level is discovered; fix the cause, do not lower this number.
  faithfulnessMin: 0.9,
  hallucinationRateMax: 0.05,
  // Abstention gates, measurable for the first time since item 3.1 added an
  // unanswerable slice. Set from the behaviour a correct system exhibits, not
  // from what the current system measures: expect the first runs to fail while
  // the true false-answer level is discovered. Fix the cause, do not lower
  // these numbers.
  falseAnswerRateMax: 0.1,
  falseAbstentionRateMax: 0.05,
  // Same floors as the aggregate gates: a per-language miss is a real miss.
  // EN measured 0.667 recall while the aggregate passed on DE — these exist
  // precisely so that keeps failing until EN itself is fixed.
  perLanguageRecallAt5: 0.85,
  perLanguageNdcgAt10: 0.8,
  perLanguageMinQueries: 5,
  cacheHitRate: 0.3,
  uncachedP50LatencyMs: 8000,
  uncachedP95LatencyMs: 15000,
  cachedP50LatencyMs: 7000,
  cachedP95LatencyMs: 12000,
};

export type BenchmarkSummaryMetrics = {
  queryCount: number;
  evaluatedCount: number;
  systemErrorCount: number;
  /**
   * The answerable/unanswerable split. Retrieval, citation and judge averages
   * run over the answerable slice only — an unanswerable question has no gold
   * evidence to retrieve, so including it would zero-drag every average.
   */
  answerableCount: number;
  unanswerableCount: number;
  /**
   * Fraction of evaluated unanswerable queries the system answered instead of
   * abstaining on. 0 when the slice is empty. Computed from the production
   * `insufficientEvidence` flag, so it works with the judge disabled.
   */
  falseAnswerRate: number;
  /** Fraction of evaluated answerable queries the system abstained on. */
  falseAbstentionRate: number;
  recallAt5: number;
  ndcgAt10: number;
  mrr: number;
  citationAccuracy: number;
  /** Averages over queries that produced a score; abstentions are excluded. */
  groundingScore: number;
  hallucinationRate: number;
  groundedQueryCount: number;
  cacheHitRate: number;
  uncachedP50LatencyMs: number;
  uncachedP95LatencyMs: number;
  cachedP50LatencyMs: number;
  cachedP95LatencyMs: number;
  systemErrorRate: number;
  citationEvidenceHitRate: number;
  /** Average over queries where the citation verifier produced verdicts. */
  verifiedCitationRate: number;
  verifiedQueryCount: number;
  /** Number of queries with a successful LLM-judge evaluation. */
  judgedCount: number;
  /** Averages over judged queries only; 0 when judgedCount is 0. */
  faithfulness: number;
  answerRelevance: number;
  contextPrecision: number;
  contextRecall: number;
  abstentionRate: number;
  /**
   * Share of answers the generator cut off at RAG_LLM_MAX_OUTPUT_TOKENS.
   * Report-only and deliberately ungated: a non-zero value means the run was
   * misconfigured, so it invalidates the answer-quality metrics rather than
   * being one of them.
   */
  truncationRate: number;
};

export type ThresholdResult = {
  metric: string;
  actual: number;
  target: string;
  passed: boolean;
};

export type ThresholdEvaluation = {
  passed: boolean;
  checks: ThresholdResult[];
};

export type BenchmarkFailureType =
  | "retrieval"
  | "citation"
  | "grounding"
  | "latency"
  | "cache"
  | "system_error"
  /** Answered an unanswerable question, or abstained on an answerable one. */
  | "abstention";

export type QueryFailure = {
  failureType: BenchmarkFailureType;
  probableRootCause: string;
  remediationTicket: string;
};

export type CandidateChunkTrace = Pick<
  RetrievedChunk,
  | "chunkId"
  | "documentId"
  | "pageNumber"
  | "sectionTitle"
  | "source"
  | "retrievalScore"
  | "rerankScore"
  | "relevanceScore"
  | "scoreScale"
>;

/**
 * Which score scale the retrieved chunks actually carry. "heuristic" on a
 * cross-encoder-enabled run means the Cohere call failed or timed out and the
 * silent fallback kept heuristic scores — which also swaps the evidence-gate
 * threshold. Recorded per query so that fallback is visible in artifacts and
 * threshold calibration can refuse contaminated runs.
 */
export type ScoreScaleComposition =
  "cross_encoder" | "heuristic" | "mixed" | "unknown";

/**
 * The answering service's three-way evidence read (Wave 4.3), persisted per
 * query so ambiguous-band frequency and loop actions are measurable from
 * artifacts. Null on the error path and for artifacts predating the loop.
 */
export type EvidenceAssessmentTrace = {
  verdict: "sufficient" | "ambiguous" | "insufficient";
  top1Relevance: number | null;
  top3MeanRelevance: number | null;
  scale: ScoreScaleComposition;
  actionsTaken: string[];
  loopEnabled: boolean;
};

export type QueryBenchmarkResult = {
  id: string;
  language: SupportedLanguage;
  question: string;
  questionType: EvaluationQuestionType;
  retrieval: {
    cacheHit: boolean;
    candidateCounts: {
      vector: number;
      keyword: number;
      fused: number;
      reranked: number;
    };
    chunks: CandidateChunkTrace[];
    scoreScaleComposition: ScoreScaleComposition;
  };
  answer: {
    text: string;
    citations: Citation[];
    insufficientEvidence: boolean;
    /** Generator hit RAG_LLM_MAX_OUTPUT_TOKENS; a config bug, not a quality signal. */
    truncated: boolean;
  };
  evidenceAssessment: EvidenceAssessmentTrace | null;
  metrics: QueryRetrievalMetrics &
    QueryAnswerMetrics &
    QueryLatencyMetrics & {
      cacheHitOnRepeat: boolean;
    };
  judge: QueryJudgeMetrics | null;
  failures: QueryFailure[];
  error: string | null;
};
