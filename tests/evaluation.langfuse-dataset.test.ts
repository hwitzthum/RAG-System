import assert from "node:assert/strict";
import test from "node:test";
import {
  benchmarkScores,
  datasetItemIdFor,
  datasetNameForFingerprint,
} from "@/lib/evaluation/langfuse-dataset";
import type { QueryBenchmarkResult } from "@/lib/evaluation/types";

function buildResult(
  overrides: {
    metrics?: Partial<QueryBenchmarkResult["metrics"]>;
    judge?: QueryBenchmarkResult["judge"];
    insufficientEvidence?: boolean;
  } = {},
): QueryBenchmarkResult {
  return {
    id: "en-test-0",
    language: "EN",
    question: "What is the reporting cadence?",
    questionType: "single_hop",
    retrieval: {
      cacheHit: false,
      candidateCounts: { vector: 3, keyword: 3, fused: 3, reranked: 1 },
      chunks: [],
      scoreScaleComposition: "cross_encoder",
      queryDecomposition: null,
    },
    answer: {
      text: "Quarterly.",
      citations: [],
      insufficientEvidence: overrides.insufficientEvidence ?? false,
      truncated: false,
    },
    evidenceAssessment: null,
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
      ...overrides.metrics,
    },
    judge: overrides.judge ?? null,
    failures: [],
    error: null,
  };
}

test("datasetNameForFingerprint keys the dataset on the corpus fingerprint", () => {
  // The fingerprint belongs in the name so that re-chunking produces a new
  // dataset instead of rewriting items earlier runs were scored against.
  assert.equal(
    datasetNameForFingerprint(
      "7125c1245ec8d65dcf5f09f6904ff23fdd433f3e0dee6022eabc67bf9b629e98",
    ),
    "golden-set-7125c1245ec8",
  );

  assert.notEqual(
    datasetNameForFingerprint("7125c1245ec8aaaa"),
    datasetNameForFingerprint("ffffffffffffbbbb"),
  );
});

test("datasetItemIdFor scopes the record id by corpus fingerprint", () => {
  // Record ids survive a re-chunk of the same document, and Langfuse resolves
  // item ids project-wide, so an unscoped id would attach a run to an older
  // golden set's item instead of failing loudly.
  const fingerprintA =
    "34ec45e9d5b7a0fb006deccfd51c644244111c4721e082f0edd810abb2b0dec3";
  const fingerprintB =
    "7125c1245ec8d65dcf5f09f6904ff23fdd433f3e0dee6022eabc67bf9b629e98";

  assert.equal(
    datasetItemIdFor(fingerprintA, "en-2e51c566-5"),
    "34ec45e9d5b7-en-2e51c566-5",
  );
  assert.notEqual(
    datasetItemIdFor(fingerprintA, "en-2e51c566-5"),
    datasetItemIdFor(fingerprintB, "en-2e51c566-5"),
  );
});

test("benchmarkScores publishes the gated retrieval and citation metrics", () => {
  const names = benchmarkScores(buildResult()).map((score) => score.name);

  for (const expected of [
    "recall_at_5",
    "ndcg_at_10",
    "mrr",
    "citation_accuracy",
    "citation_evidence_hit",
    "verified_citation_rate",
    "hallucination_rate",
    "abstained",
  ]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
});

test("benchmarkScores omits judge dimensions when the judge did not run", () => {
  const names = benchmarkScores(buildResult()).map((score) => score.name);

  assert.equal(names.includes("faithfulness"), false);
  assert.equal(names.includes("context_precision"), false);
});

test("benchmarkScores includes judge dimensions when the judge ran", () => {
  const scores = benchmarkScores(
    buildResult({
      judge: {
        judged: true,
        faithfulness: 1,
        answerRelevance: 0.85,
        contextPrecision: 0.25,
        contextRecall: 1,
        abstained: false,
        unsupportedStatementCount: 0,
      },
    }),
  );
  const byName = new Map(scores.map((s) => [s.name, s.value]));

  assert.equal(byName.get("faithfulness"), 1);
  assert.equal(byName.get("answer_relevance"), 0.85);
  assert.equal(byName.get("context_precision"), 0.25);
  assert.equal(byName.get("context_recall"), 1);
});

test("benchmarkScores drops unmeasured metrics rather than reporting them as zero", () => {
  // A null verifiedCitationRate means the verifier did not run. Publishing it
  // as 0 would be indistinguishable from every citation failing verification,
  // and would drag the cross-run average down for a reason unrelated to
  // quality.
  const scores = benchmarkScores(
    buildResult({ metrics: { verifiedCitationRate: null } }),
  );
  const names = scores.map((score) => score.name);

  assert.equal(names.includes("verified_citation_rate"), false);
  assert.equal(names.includes("recall_at_5"), true);
  assert.ok(scores.every((score) => Number.isFinite(score.value)));
});

test("benchmarkScores records abstention as a per-record signal", () => {
  const answered = benchmarkScores(buildResult()).find(
    (s) => s.name === "abstained",
  );
  const abstained = benchmarkScores(
    buildResult({ insufficientEvidence: true }),
  ).find((s) => s.name === "abstained");

  assert.equal(answered?.value, 0);
  assert.equal(abstained?.value, 1);
  // The question type travels with it: falseAnswerRate and
  // falseAbstentionRate are only interpretable against it.
  assert.match(abstained?.comment ?? "", /question_type=single_hop/);
});
