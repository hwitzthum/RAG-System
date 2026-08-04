import type {
  Citation,
  RetrievedChunk,
  SupportedLanguage,
} from "@/lib/contracts/retrieval";

export const EVALUATION_LANGUAGES = ["EN", "DE", "FR", "IT", "ES"] as const;

export type EvaluationLanguage = (typeof EVALUATION_LANGUAGES)[number];

export type EvaluationQueryRecord = {
  id: string;
  language: EvaluationLanguage;
  question: string;
  expected_document: string;
  expected_section: string;
  expected_pages: number[];
  acceptable_answer_points: string[];
};

export type DatasetValidationOptions = {
  minTotalQueries: number;
  minPerLanguage: number;
};

export type DatasetValidationResult = {
  records: EvaluationQueryRecord[];
  totalQueries: number;
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
  citationAccuracy: number;
  groundingScore: number;
  hallucinationRate: number;
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
  citationAccuracy: number;
  hallucinationRateMax: number;
  cacheHitRate: number;
  uncachedP95LatencyMs: number;
  cachedP95LatencyMs: number;
};

export const DEFAULT_BENCHMARK_THRESHOLDS: BenchmarkThresholds = {
  recallAt5: 0.85,
  ndcgAt10: 0.8,
  citationAccuracy: 0.9,
  hallucinationRateMax: 0.05,
  cacheHitRate: 0.3,
  uncachedP95LatencyMs: 7000,
  cachedP95LatencyMs: 2500,
};

export type BenchmarkSummaryMetrics = {
  queryCount: number;
  evaluatedCount: number;
  systemErrorCount: number;
  recallAt5: number;
  ndcgAt10: number;
  mrr: number;
  citationAccuracy: number;
  groundingScore: number;
  hallucinationRate: number;
  cacheHitRate: number;
  uncachedP50LatencyMs: number;
  uncachedP95LatencyMs: number;
  cachedP50LatencyMs: number;
  cachedP95LatencyMs: number;
  systemErrorRate: number;
  /** Number of queries with a successful LLM-judge evaluation. */
  judgedCount: number;
  /** Averages over judged queries only; 0 when judgedCount is 0. */
  faithfulness: number;
  answerRelevance: number;
  contextPrecision: number;
  contextRecall: number;
  abstentionRate: number;
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
  "retrieval" | "citation" | "grounding" | "latency" | "cache" | "system_error";

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
>;

export type QueryBenchmarkResult = {
  id: string;
  language: SupportedLanguage;
  question: string;
  retrieval: {
    cacheHit: boolean;
    candidateCounts: {
      vector: number;
      keyword: number;
      fused: number;
      reranked: number;
    };
    chunks: CandidateChunkTrace[];
  };
  answer: {
    text: string;
    citations: Citation[];
    insufficientEvidence: boolean;
  };
  metrics: QueryRetrievalMetrics &
    QueryAnswerMetrics &
    QueryLatencyMetrics & {
      cacheHitOnRepeat: boolean;
    };
  judge: QueryJudgeMetrics | null;
  failures: QueryFailure[];
  error: string | null;
};
