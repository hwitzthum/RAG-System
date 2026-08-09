import type { QueryBenchmarkResult } from "@/lib/evaluation/types";

/**
 * Bridge between the local golden set and Langfuse Datasets.
 *
 * The JSON golden set stays the source of truth: it is regenerated from the
 * corpus, bound to a corpus fingerprint, and read by the release gate, which
 * must stay local and deterministic. Langfuse gets a mirror of it so runs can
 * be compared and a metric can be traced back to the retrieval that produced
 * it.
 */

/**
 * The corpus fingerprint is part of the dataset NAME, not its metadata.
 *
 * Langfuse upserts dataset items by id, and the golden set is regenerated
 * whenever the corpus is re-chunked — at which point `expected_chunk_ids`
 * refer to chunks that no longer exist. Keying on the fingerprint means a
 * re-chunk produces a new dataset rather than silently rewriting the items
 * that earlier runs were scored against, which is exactly the comparability
 * the fingerprint envelope exists to protect.
 */
export function datasetNameForFingerprint(corpusFingerprint: string): string {
  return `golden-set-${corpusFingerprint.slice(0, 12)}`;
}

export type BenchmarkScore = {
  name: string;
  value: number;
  comment?: string;
};

/**
 * The metrics worth trending in Langfuse: every value the release gate reads,
 * plus the judge dimensions.
 *
 * Deliberately excludes latency and cache timings — those are already on the
 * trace as span durations, and duplicating them as scores would invite the two
 * to disagree. Unjudged records contribute no judge scores rather than zeros,
 * so a judge failure shows up as missing data instead of as a quality drop.
 */
export function benchmarkScores(
  result: QueryBenchmarkResult,
): BenchmarkScore[] {
  // A null metric means "not measured" — the citation verifier or the judge did
  // not run. Those are dropped rather than sent as 0, because once a zero lands
  // in an aggregate it is indistinguishable from a genuine failure.
  const candidates: Array<{
    name: string;
    value: number | null | undefined;
    comment?: string;
  }> = [
    { name: "recall_at_5", value: result.metrics.recallAt5 },
    { name: "ndcg_at_10", value: result.metrics.ndcgAt10 },
    { name: "mrr", value: result.metrics.mrr },
    { name: "citation_accuracy", value: result.metrics.citationAccuracy },
    {
      name: "citation_evidence_hit",
      value: result.metrics.citationEvidenceHit,
    },
    {
      name: "verified_citation_rate",
      value: result.metrics.verifiedCitationRate,
    },
    { name: "hallucination_rate", value: result.metrics.hallucinationRate },
    // Abstention is the per-record signal behind falseAnswerRate and
    // falseAbstentionRate, which are aggregate-only. Recording it is what makes
    // those aggregates explainable from the UI.
    {
      name: "abstained",
      value: result.answer.insufficientEvidence ? 1 : 0,
      comment: `question_type=${result.questionType}`,
    },
  ];

  const judge = result.judge;
  if (judge?.judged) {
    candidates.push(
      { name: "faithfulness", value: judge.faithfulness },
      { name: "answer_relevance", value: judge.answerRelevance },
      { name: "context_precision", value: judge.contextPrecision },
      { name: "context_recall", value: judge.contextRecall },
    );
  }

  return candidates
    .filter(
      (entry) =>
        typeof entry.value === "number" && Number.isFinite(entry.value),
    )
    .map((entry) => ({
      name: entry.name,
      value: entry.value as number,
      ...(entry.comment ? { comment: entry.comment } : {}),
    }));
}
