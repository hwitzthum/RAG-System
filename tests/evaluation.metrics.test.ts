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
    },
    metrics: {
      ...retrieval,
      ...answer,
      uncachedLatencyMs: 1500,
      cachedLatencyMs: 400,
      cacheHitOnRepeat: true,
    },
    judge: null,
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
        hallucinationRate: 0.8,
        cacheHitOnRepeat: false,
        uncachedLatencyMs: 9000,
        cachedLatencyMs: 3000,
      },
    },
  ]).overall;
  const failing = evaluateThresholds(failingSummary);
  assert.equal(failing.passed, false);
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
    answer: { text: "answer", citations: [], insufficientEvidence: false },
    metrics: {
      recallAt5: 1,
      ndcgAt10: 1,
      mrr: 1,
      firstRelevantRank: 1,
      relevantRanks: [1],
      citationAccuracy: 1,
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
