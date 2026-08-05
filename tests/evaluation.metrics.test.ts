import assert from "node:assert/strict";
import test from "node:test";
import type { RetrievedChunk } from "../lib/contracts/retrieval";
import { validateEvaluationDataset } from "../lib/evaluation/dataset";
import {
  computeRetrievalMetrics,
  evaluateThresholds,
  stripLimitationsSection,
  summarizeBenchmark,
} from "../lib/evaluation/metrics";
import type {
  BenchmarkSummaryMetrics,
  EvaluationDatasetEnvelope,
  EvaluationQueryRecord,
  QueryBenchmarkResult,
} from "../lib/evaluation/types";

/**
 * Inline golden records. The 200-record synthetic fixture these tests used to
 * import named documents that existed nowhere in the corpus, and keeping it
 * alive meant the benchmark could still be pointed at ground truth that
 * measured nothing (item 3.1).
 */
function buildRecord(
  overrides: Partial<EvaluationQueryRecord> = {},
): EvaluationQueryRecord {
  return {
    id: "en-doc-profile-01",
    language: "EN",
    question: "How is the company ownership model documented?",
    question_type: "single_hop",
    expected_chunk_ids: ["chunk-golden-1"],
    expected_document: "doc_company_profile",
    expected_section: "Company Overview",
    expected_pages: [1],
    acceptable_answer_points: [
      "Ownership model is documented.",
      "Leadership team responsibilities are listed.",
      "Reporting lines are defined.",
    ],
    ...overrides,
  };
}

function buildUnanswerableRecord(
  overrides: Partial<EvaluationQueryRecord> = {},
): EvaluationQueryRecord {
  return buildRecord({
    id: "ua-en-1",
    question: "What was the acquisition price of the Mars subsidiary?",
    question_type: "unanswerable",
    expected_chunk_ids: [],
    expected_document: "",
    expected_section: "",
    expected_pages: [],
    acceptable_answer_points: [],
    ...overrides,
  });
}

function buildEnvelope(
  records: EvaluationQueryRecord[],
): EvaluationDatasetEnvelope {
  return {
    corpusFingerprint: "fp-test",
    generatedAt: "2026-08-05T00:00:00.000Z",
    generatorModel: "test-model",
    records,
  };
}

/** A spread of answerable records satisfying the 5-per-language floor. */
function answerableSpread(language: "EN" | "DE", count: number) {
  return Array.from({ length: count }, (_, index) =>
    buildRecord({
      id: `${language.toLowerCase()}-rec-${index}`,
      language,
      expected_chunk_ids: [`chunk-${language}-${index}`],
    }),
  );
}

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

// ---- Dataset validation -----------------------------------------------------

test("dataset validation accepts an envelope and reports slice counts", () => {
  const envelope = buildEnvelope([
    ...answerableSpread("EN", 15),
    ...answerableSpread("DE", 15),
    buildUnanswerableRecord(),
  ]);

  const result = validateEvaluationDataset(envelope);
  assert.equal(result.corpusFingerprint, "fp-test");
  assert.equal(result.totalQueries, 31);
  assert.equal(result.answerableCount, 30);
  assert.equal(result.unanswerableCount, 1);
  // Unanswerable records do not pad language counts.
  assert.equal(result.languageCounts.EN, 15);
});

test("dataset validation refuses a bare record array (no corpus binding)", () => {
  const records = [
    ...answerableSpread("EN", 15),
    ...answerableSpread("DE", 15),
  ];
  assert.throws(() => validateEvaluationDataset(records), /envelope/);
});

test("dataset validation enforces per-type record constraints", () => {
  // Answerable without chunk ids: rejected.
  assert.throws(() =>
    validateEvaluationDataset(
      buildEnvelope([
        ...answerableSpread("EN", 14),
        ...answerableSpread("DE", 15),
        buildRecord({ id: "broken", expected_chunk_ids: [] }),
      ]),
    ),
  );

  // Unanswerable carrying chunk ids: rejected.
  assert.throws(() =>
    validateEvaluationDataset(
      buildEnvelope([
        ...answerableSpread("EN", 15),
        ...answerableSpread("DE", 15),
        buildUnanswerableRecord({ expected_chunk_ids: ["chunk-x"] }),
      ]),
    ),
  );
});

test("per-language floor applies to the answerable slice only", () => {
  // 15 EN answerable + 4 DE answerable: DE misses the floor of 5 even though
  // DE unanswerable records would push it over if they counted.
  assert.throws(
    () =>
      validateEvaluationDataset(
        buildEnvelope([
          ...answerableSpread("EN", 25),
          ...answerableSpread("DE", 4),
          buildUnanswerableRecord({ id: "ua-de-1", language: "DE" }),
        ]),
      ),
    /language DE/,
  );
});

// ---- Retrieval relevance ----------------------------------------------------

test("chunk-id ground truth judges relevance by exact chunk hit", () => {
  const record = buildRecord({ expected_chunk_ids: ["chunk-golden-1"] });

  // Right document and page but the WRONG chunk: not relevant.
  const wrongChunk = [
    buildChunk({
      chunkId: "chunk-other",
      pageNumber: record.expected_pages[0],
    }),
  ];
  assert.equal(computeRetrievalMetrics(record, wrongChunk).recallAt5, 0);

  // The golden chunk id is relevant even when its page/section labels moved
  // (a re-chunk shifts pages; section labels are extraction artifacts).
  const goldenChunk = [
    buildChunk({
      chunkId: "chunk-golden-1",
      pageNumber: 999,
      sectionTitle: "A different heading after re-chunking",
    }),
  ];
  assert.equal(computeRetrievalMetrics(record, goldenChunk).recallAt5, 1);
});

test("legacy records without chunk ids fall back to the page proxy", () => {
  const record = buildRecord({ expected_chunk_ids: [] });

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

test("multi-hop nDCG requires both golden chunks for a perfect score", () => {
  const record = buildRecord({
    question_type: "multi_hop",
    expected_chunk_ids: ["chunk-a", "chunk-b"],
  });

  const oneOfTwo = computeRetrievalMetrics(record, [
    buildChunk({ chunkId: "chunk-a" }),
    buildChunk({ chunkId: "noise-1", documentId: "noise" }),
  ]);
  assert.equal(oneOfTwo.recallAt5, 1);
  assert.equal(oneOfTwo.ndcgAt10 < 1, true);

  const bothChunks = computeRetrievalMetrics(record, [
    buildChunk({ chunkId: "chunk-a" }),
    buildChunk({ chunkId: "chunk-b" }),
  ]);
  assert.equal(bothChunks.ndcgAt10, 1);
});

// ---- Summary + thresholds ---------------------------------------------------

function buildResult(
  overrides: Partial<QueryBenchmarkResult> = {},
): QueryBenchmarkResult {
  const record = buildRecord();
  return {
    id: record.id,
    language: record.language,
    question: record.question,
    questionType: "single_hop",
    retrieval: {
      cacheHit: false,
      candidateCounts: { vector: 3, keyword: 3, fused: 3, reranked: 1 },
      chunks: [
        {
          chunkId: "chunk-golden-1",
          documentId: record.expected_document,
          pageNumber: record.expected_pages[0]!,
          sectionTitle: record.expected_section,
          source: "hybrid",
          retrievalScore: 0.9,
          rerankScore: 0.8,
          relevanceScore: 0.8,
          scoreScale: "cross_encoder",
        },
      ],
      scoreScaleComposition: "cross_encoder",
    },
    answer: {
      text: "Ownership model is documented.",
      citations: [
        {
          documentId: record.expected_document,
          pageNumber: record.expected_pages[0]!,
          chunkId: "chunk-golden-1",
        },
      ],
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
      verifiedCitationRate: 1,
      groundingScore: 1,
      hallucinationRate: 0,
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
}

test("benchmark thresholds detect pass/fail conditions from summary", () => {
  const passingSummary = summarizeBenchmark([buildResult()]).overall;
  const passing = evaluateThresholds(passingSummary);
  assert.equal(passing.passed, true);

  const base = buildResult();
  const failingSummary = summarizeBenchmark([
    {
      ...base,
      metrics: {
        ...base.metrics,
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

test("unanswerable queries feed falseAnswerRate, not the retrieval averages", () => {
  const answered = buildResult();
  const falseAnswer: QueryBenchmarkResult = {
    ...buildResult(),
    id: "ua-answered",
    questionType: "unanswerable",
    answer: {
      text: "A confident hallucination.",
      citations: [],
      insufficientEvidence: false,
      truncated: false,
    },
    metrics: {
      ...buildResult().metrics,
      // Zero retrieval scores: there is no gold evidence to retrieve.
      recallAt5: 0,
      ndcgAt10: 0,
      mrr: 0,
      citationAccuracy: 0,
      citationEvidenceHit: 0,
      verifiedCitationRate: null,
    },
    judge: null,
  };
  const correctAbstention: QueryBenchmarkResult = {
    ...falseAnswer,
    id: "ua-abstained",
    answer: { ...falseAnswer.answer, insufficientEvidence: true },
  };

  const summary = summarizeBenchmark([
    answered,
    falseAnswer,
    correctAbstention,
  ]).overall;

  assert.equal(summary.answerableCount, 1);
  assert.equal(summary.unanswerableCount, 2);
  // One of two unanswerable queries was answered.
  assert.equal(summary.falseAnswerRate, 0.5);
  assert.equal(summary.falseAbstentionRate, 0);
  // The unanswerable zeros must NOT drag the retrieval averages.
  assert.equal(summary.recallAt5, 1);
  assert.equal(summary.ndcgAt10, 1);
  assert.equal(summary.citationEvidenceHitRate, 1);

  // And the gate fails on a 0.5 false-answer rate.
  const evaluation = evaluateThresholds(summary);
  const gate = evaluation.checks.find((check) =>
    check.metric.startsWith("False answer rate"),
  );
  assert.ok(gate);
  assert.equal(gate.passed, false);
});

test("abstaining on an answerable query raises falseAbstentionRate and fails its gate", () => {
  const base = buildResult();
  const abstained: QueryBenchmarkResult = {
    ...base,
    id: "answerable-abstained",
    answer: { ...base.answer, insufficientEvidence: true },
  };

  const summary = summarizeBenchmark([abstained]).overall;
  assert.equal(summary.falseAbstentionRate, 1);

  const evaluation = evaluateThresholds(summary);
  const gate = evaluation.checks.find((check) =>
    check.metric.startsWith("False abstention rate"),
  );
  assert.ok(gate);
  assert.equal(gate.passed, false);
});

test("per-language gates stop one language hiding behind another", () => {
  // 5 perfect DE queries, 5 failing EN queries: the aggregate recall (0.5)
  // already fails, but the point is the EN-specific check failing while DE
  // passes — assert both are reported independently.
  const deResults = Array.from({ length: 5 }, (_, index) => ({
    ...buildResult(),
    id: `de-${index}`,
    language: "DE" as const,
  }));
  const enResults = Array.from({ length: 5 }, (_, index) => {
    const base = buildResult();
    return {
      ...base,
      id: `en-${index}`,
      metrics: { ...base.metrics, recallAt5: 0, ndcgAt10: 0 },
    };
  });

  const summary = summarizeBenchmark([...deResults, ...enResults]);
  const evaluation = evaluateThresholds(
    summary.overall,
    undefined,
    summary.byLanguage,
  );

  const enGate = evaluation.checks.find(
    (check) => check.metric === "Recall@5 [EN]",
  );
  const deGate = evaluation.checks.find(
    (check) => check.metric === "Recall@5 [DE]",
  );
  assert.ok(enGate);
  assert.ok(deGate);
  assert.equal(enGate.passed, false);
  assert.equal(deGate.passed, true);

  // Languages with no queries get no per-language check.
  assert.equal(
    evaluation.checks.some((check) => check.metric === "Recall@5 [FR]"),
    false,
  );
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
  const record = buildRecord();

  const metrics = computeAnswerMetrics(record, "", [], [], true, null);
  assert.equal(metrics.groundingScore, null);
  assert.equal(metrics.hallucinationRate, null);
});

test("citationEvidenceHit matches on golden chunk id, not only document/page", async () => {
  const { computeCitationEvidenceHit, computeCitationAccuracy } =
    await import("../lib/evaluation/metrics");
  const record = buildRecord({ expected_chunk_ids: ["chunk-golden-1"] });

  // One citation names the golden chunk; two more cite other (legitimate)
  // supporting evidence. The strict metric scores 1/3; the hit metric 1.
  const citations = [
    {
      documentId: record.expected_document,
      pageNumber: record.expected_pages[0]!,
      chunkId: "chunk-golden-1",
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
  // A citation to the right page but the wrong chunk is not a golden hit.
  assert.equal(computeCitationEvidenceHit(record, [citations[1]!]), 0);
});

test("verified citation rate excludes unverified queries and fails the gate with zero verified", async () => {
  const { computeAnswerMetrics, evaluateThresholds, summarizeBenchmark } =
    await import("../lib/evaluation/metrics");
  const record = buildRecord();

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
  const base = buildResult();
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

// ---- Limitations stripping --------------------------------------------------

test("stripLimitationsSection removes the section in English and German", () => {
  const english = [
    "The ownership model is documented [1].",
    "",
    "## Ownership Structure",
    "Detail sentence [2].",
    "",
    "## Limitations",
    "The evidence does not establish the founding year.",
    "It is unclear whether the model changed after 2020.",
  ].join("\n");
  const strippedEnglish = stripLimitationsSection(english);
  assert.equal(strippedEnglish.includes("Limitations"), false);
  assert.equal(strippedEnglish.includes("founding year"), false);
  assert.equal(strippedEnglish.includes("Ownership Structure"), true);
  assert.equal(strippedEnglish.includes("Detail sentence [2]."), true);

  const german = [
    "Das Modell ist dokumentiert [1].",
    "",
    "## Einschränkungen",
    "Die Belege klären nicht, wann das Modell eingeführt wurde.",
  ].join("\n");
  const strippedGerman = stripLimitationsSection(german);
  assert.equal(strippedGerman.includes("Einschränkungen"), false);
  assert.equal(strippedGerman.includes("dokumentiert"), true);
});

test("stripLimitationsSection keeps content after the section and is a no-op without one", () => {
  const withTrailingSection = [
    "Answer sentence [1].",
    "",
    "## Limitations",
    "Negative-existential claim.",
    "",
    "## Sources",
    "Source list.",
  ].join("\n");
  const stripped = stripLimitationsSection(withTrailingSection);
  assert.equal(stripped.includes("Negative-existential"), false);
  assert.equal(stripped.includes("## Sources"), true);

  const noSection = "A plain answer with no headings [1].";
  assert.equal(stripLimitationsSection(noSection), noSection);
});

const PASSING_SUMMARY: BenchmarkSummaryMetrics = {
  queryCount: 1,
  evaluatedCount: 1,
  systemErrorCount: 0,
  answerableCount: 1,
  unanswerableCount: 0,
  falseAnswerRate: 0,
  falseAbstentionRate: 0,
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
