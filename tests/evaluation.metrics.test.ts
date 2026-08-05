import assert from "node:assert/strict";
import test from "node:test";
import dataset from "../evaluation/evaluation_queries.json";
import type { RetrievedChunk } from "../lib/contracts/retrieval";
import { validateEvaluationDataset } from "../lib/evaluation/dataset";
import {
  computeRetrievalMetrics,
  evaluateThresholds,
  summarizeBenchmark,
} from "../lib/evaluation/metrics";
import type {
  BenchmarkSummaryMetrics,
  EvaluationQueryRecord,
  QueryBenchmarkResult,
} from "../lib/evaluation/types";

const records = dataset as EvaluationQueryRecord[];

function buildChunk(overrides: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    chunkId: "chunk-1",
    documentId: "doc_company_profile",
    pageNumber: 1,
    sectionTitle: "Company Overview",
    content:
      "Ownership model is documented and leadership team responsibilities are listed.",
    context: "Expected evidence context",
    language: "EN",
    source: "hybrid",
    retrievalScore: 0.9,
    rerankScore: 0.8,
    ...overrides,
  };
}

test("evaluation dataset satisfies multilingual minimum requirements", () => {
  const result = validateEvaluationDataset(records);
  assert.equal(result.totalQueries >= 200, true);
  assert.equal(result.languageCounts.EN >= 40, true);
  assert.equal(result.languageCounts.DE >= 40, true);
  assert.equal(result.languageCounts.FR >= 40, true);
  assert.equal(result.languageCounts.IT >= 40, true);
  assert.equal(result.languageCounts.ES >= 40, true);
});

test("computeRetrievalMetrics returns positive recall/ndcg/mrr when expected evidence appears", () => {
  const record = records.find(
    (item) => item.id === "en-doc_company_profile-01",
  );
  assert.ok(record);

  const chunks = [
    buildChunk({
      chunkId: "noise",
      documentId: "noise_doc_1",
      pageNumber: 99,
      sectionTitle: "Other",
    }),
    buildChunk({
      chunkId: "expected",
      documentId: record.expected_document,
      pageNumber: record.expected_pages[0],
      sectionTitle: record.expected_section,
    }),
  ];

  const retrieval = computeRetrievalMetrics(record, chunks);
  assert.equal(retrieval.recallAt5, 1);
  assert.equal(retrieval.mrr > 0, true);
  assert.equal(retrieval.ndcgAt10 > 0, true);
});

test("benchmark thresholds detect pass/fail conditions from summary", () => {
  const record = records.find(
    (item) => item.id === "en-doc_company_profile-01",
  );
  assert.ok(record);

  const retrieval = {
    recallAt5: 1,
    ndcgAt10: 1,
    mrr: 1,
    firstRelevantRank: 1,
    relevantRanks: [1],
  };
  const answer = {
    citationAccuracy: 1,
    citationEvidenceHit: 1,
    verifiedCitationRate: 1,
    groundingScore: 1,
    hallucinationRate: 0,
  };

  const baseResult: QueryBenchmarkResult = {
    id: record.id,
    language: record.language,
    question: record.question,
    retrieval: {
      cacheHit: false,
      candidateCounts: { vector: 3, keyword: 3, fused: 3, reranked: 1 },
      chunks: [
        {
          chunkId: "chunk-1",
          documentId: record.expected_document,
          pageNumber: record.expected_pages[0],
          sectionTitle: record.expected_section,
          source: "hybrid",
          retrievalScore: 0.9,
          rerankScore: 0.8,
        },
      ],
    },
    answer: {
      text: "Ownership model is documented.",
      citations: [
        {
          documentId: record.expected_document,
          pageNumber: record.expected_pages[0],
          chunkId: "chunk-1",
        },
      ],
      insufficientEvidence: false,
      truncated: false,
    },
    metrics: {
      ...retrieval,
      ...answer,
      uncachedLatencyMs: 1500,
      cachedLatencyMs: 400,
      cacheHitOnRepeat: true,
    },
    judge: {
      judged: true,
      faithfulness: 1,
      answerRelevance: 1,
      contextPrecision: 1,
      contextRecall: 1,
      abstained: false,
      unsupportedStatementCount: 0,
    },
    failures: [],
    error: null,
  };

  const passingSummary = summarizeBenchmark([baseResult]).overall;
  const passing = evaluateThresholds(passingSummary);
  assert.equal(passing.passed, true);

  const failingSummary = summarizeBenchmark([
    {
      ...baseResult,
      metrics: {
        ...baseResult.metrics,
        recallAt5: 0,
        ndcgAt10: 0,
        citationAccuracy: 0,
        citationEvidenceHit: 0,
        verifiedCitationRate: 0.5,
        cacheHitOnRepeat: false,
        uncachedLatencyMs: 16000,
        cachedLatencyMs: 13000,
      },
    },
  ]).overall;
  const failing = evaluateThresholds(failingSummary);
  assert.equal(failing.passed, false);
});

test("faithfulness gates the build and fails closed when nothing was judged", () => {
  const passing: BenchmarkSummaryMetrics = {
    ...PASSING_SUMMARY,
    judgedCount: 1,
    faithfulness: 0.95,
  };
  const evaluation = evaluateThresholds(passing);
  const check = evaluation.checks.find((item) =>
    item.metric.startsWith("Faithfulness"),
  );
  assert.ok(check, "faithfulness must be a gated check");
  assert.equal(check.passed, true);

  // Below the threshold blocks the build.
  const belowThreshold = evaluateThresholds({
    ...passing,
    faithfulness: 0.5,
  });
  assert.equal(belowThreshold.passed, false);

  // Zero judged queries must fail loudly rather than pass on an empty average.
  const unjudged = evaluateThresholds({
    ...passing,
    judgedCount: 0,
    faithfulness: 0,
  });
  assert.equal(unjudged.passed, false);
});

test("the token-overlap grounding metric no longer gates the build", () => {
  const evaluation = evaluateThresholds({
    ...PASSING_SUMMARY,
    judgedCount: 1,
    faithfulness: 1,
    groundingScore: 0,
    hallucinationRate: 1,
    groundedQueryCount: 1,
  });
  assert.equal(
    evaluation.checks.some((check) => check.metric === "Hallucination rate"),
    false,
  );
  assert.equal(evaluation.passed, true);
});

test("an abstention scores null grounding instead of a perfect score", async () => {
  const { computeAnswerMetrics } = await import("../lib/evaluation/metrics");
  const record = records.find(
    (item) => item.id === "en-doc_company_profile-01",
  );
  assert.ok(record);

  const metrics = computeAnswerMetrics(record, "", [], [], true, null);
  assert.equal(metrics.groundingScore, null);
  assert.equal(metrics.hallucinationRate, null);
});

test("citationEvidenceHit does not penalise extra citations from multi-chunk synthesis", async () => {
  const { computeCitationEvidenceHit, computeCitationAccuracy } =
    await import("../lib/evaluation/metrics");
  const record = records.find(
    (item) => item.id === "en-doc_company_profile-01",
  );
  assert.ok(record);

  // One citation hits the golden evidence; two more cite other (legitimate)
  // supporting pages. The strict metric scores 1/3; the hit metric scores 1.
  const citations = [
    {
      documentId: record.expected_document,
      pageNumber: record.expected_pages[0]!,
      chunkId: "golden",
    },
    {
      documentId: record.expected_document,
      pageNumber: 999,
      chunkId: "extra1",
    },
    { documentId: "other-doc", pageNumber: 1, chunkId: "extra2" },
  ];

  assert.equal(computeCitationEvidenceHit(record, citations), 1);
  assert.ok(computeCitationAccuracy(record, citations) < 0.5);
  assert.equal(computeCitationEvidenceHit(record, [citations[1]!]), 0);
});

test("verified citation rate excludes unverified queries and fails the gate with zero verified", async () => {
  const { computeAnswerMetrics, evaluateThresholds, summarizeBenchmark } =
    await import("../lib/evaluation/metrics");
  const record = records.find(
    (item) => item.id === "en-doc_company_profile-01",
  );
  assert.ok(record);

  // Verifier ran: rate = supported/checked.
  const verified = computeAnswerMetrics(
    record,
    "Ownership model is documented [1].",
    [],
    [],
    false,
    { checkedCount: 4, supportedCount: 3, unverified: false },
  );
  assert.equal(verified.verifiedCitationRate, 0.75);

  // Verifier failed: null, never a perfect score.
  const unverified = computeAnswerMetrics(
    record,
    "Ownership model is documented [1].",
    [],
    [],
    false,
    { checkedCount: 0, supportedCount: 0, unverified: true },
  );
  assert.equal(unverified.verifiedCitationRate, null);

  // A summary with zero verified queries must fail the verified-citation gate.
  const summary = summarizeBenchmark([]).overall;
  const evaluation = evaluateThresholds(summary);
  const gate = evaluation.checks.find(
    (check) => check.metric === "Verified citation rate",
  );
  assert.ok(gate);
  assert.equal(gate.passed, false);
});

test("summarizeBenchmark averages judge metrics over judged queries only", () => {
  const record = records.find(
    (item) => item.id === "en-doc_company_profile-01",
  );
  assert.ok(record);

  const base: QueryBenchmarkResult = {
    id: record.id,
    language: record.language,
    question: record.question,
    retrieval: {
      cacheHit: false,
      candidateCounts: { vector: 1, keyword: 1, fused: 1, reranked: 1 },
      chunks: [],
    },
    answer: {
      text: "answer",
      citations: [],
      insufficientEvidence: false,
      truncated: false,
    },
    metrics: {
      recallAt5: 1,
      ndcgAt10: 1,
      mrr: 1,
      firstRelevantRank: 1,
      relevantRanks: [1],
      citationAccuracy: 1,
      citationEvidenceHit: 1,
      verifiedCitationRate: null,
      groundingScore: 1,
      hallucinationRate: 0,
      uncachedLatencyMs: 1000,
      cachedLatencyMs: 300,
      cacheHitOnRepeat: true,
    },
    judge: null,
    failures: [],
    error: null,
  };

  const summary = summarizeBenchmark([
    {
      ...base,
      id: "judged-1",
      judge: {
        judged: true,
        faithfulness: 1,
        answerRelevance: 0.8,
        contextPrecision: 0.5,
        contextRecall: 1,
        abstained: false,
        unsupportedStatementCount: 0,
      },
    },
    {
      ...base,
      id: "judged-2-abstained",
      judge: {
        judged: true,
        faithfulness: 1,
        answerRelevance: 0,
        contextPrecision: null,
        contextRecall: 0.5,
        abstained: true,
        unsupportedStatementCount: 0,
      },
    },
    // Failed judge call: excluded from averages, not scored as perfect.
    { ...base, id: "unjudged", judge: null },
  ]).overall;

  assert.equal(summary.judgedCount, 2);
  assert.equal(summary.faithfulness, 1);
  assert.equal(summary.answerRelevance, 0.4);
  // null contextPrecision on the abstained query is excluded, not zeroed.
  assert.equal(summary.contextPrecision, 0.5);
  assert.equal(summary.contextRecall, 0.75);
  assert.equal(summary.abstentionRate, 0.5);
});

const PASSING_SUMMARY: BenchmarkSummaryMetrics = {
  queryCount: 1,
  evaluatedCount: 1,
  systemErrorCount: 0,
  recallAt5: 1,
  ndcgAt10: 1,
  mrr: 1,
  citationAccuracy: 1,
  groundingScore: 1,
  hallucinationRate: 0,
  groundedQueryCount: 1,
  cacheHitRate: 1,
  uncachedP50LatencyMs: 1500,
  uncachedP95LatencyMs: 1500,
  cachedP50LatencyMs: 400,
  cachedP95LatencyMs: 400,
  systemErrorRate: 0,
  citationEvidenceHitRate: 1,
  verifiedCitationRate: 1,
  verifiedQueryCount: 1,
  judgedCount: 1,
  faithfulness: 1,
  answerRelevance: 1,
  contextPrecision: 1,
  contextRecall: 1,
  abstentionRate: 0,
  truncationRate: 0,
};
