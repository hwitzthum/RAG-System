import type {
  RelevanceScoreScale,
  RetrievedChunk,
} from "@/lib/contracts/retrieval";

export type EvidencePolicyInput = {
  chunks: RetrievedChunk[];
  minEvidenceChunks: number;
  /** Threshold applied when chunks were scored by the Cohere cross-encoder. */
  minRerankScore: number;
  /** Threshold applied when chunks were scored by the heuristic reranker. */
  minHeuristicRelevance: number;
  documentScoped?: boolean;
};

/**
 * The absolute relevance of a chunk, never its ordering score.
 *
 * `rerankScore` is normalised against the pool maximum and carries positional
 * boosts, so the best candidate of any pool sits near the top of the range no
 * matter how irrelevant it is. Reading it here is why this gate never fired in
 * the default configuration. `relevanceScore` is pool-independent.
 *
 * The fallback chain matters for cached entries written before `relevanceScore`
 * existed: those degrade to the old (permissive) behaviour rather than being
 * treated as zero-relevance and refused.
 */
export function resolveRelevance(chunk: RetrievedChunk): number {
  return chunk.relevanceScore ?? chunk.rerankScore ?? chunk.retrievalScore;
}

/**
 * Cohere relevance scores and the heuristic blend are not on a shared scale, so
 * a single threshold would mean two different things depending on whether
 * RAG_CROSS_ENCODER_ENABLED happened to be set.
 */
function resolveThreshold(
  scale: RelevanceScoreScale | undefined,
  input: EvidencePolicyInput,
): number {
  return scale === "cross_encoder"
    ? input.minRerankScore
    : input.minHeuristicRelevance;
}

export function hasSufficientEvidence(input: EvidencePolicyInput): boolean {
  const requiredChunkCount = input.documentScoped
    ? 1
    : Math.max(1, input.minEvidenceChunks);

  if (input.chunks.length < requiredChunkCount) {
    return false;
  }

  // At least one chunk must meet the minimum score threshold.
  const hasStrongChunk = input.chunks.some(
    (chunk) =>
      resolveRelevance(chunk) >= resolveThreshold(chunk.scoreScale, input),
  );
  if (!hasStrongChunk) {
    return false;
  }

  // The top chunks (up to minEvidenceChunks) must have a reasonable average score
  // to avoid answering when only one chunk is marginally relevant.
  // Set at half the per-chunk minimum: a strong lead chunk can compensate for weaker supporting ones.
  const AVG_SCORE_THRESHOLD_RATIO = 0.5;
  const topChunks = input.chunks.slice(0, requiredChunkCount);
  const avgScore =
    topChunks.reduce((sum, c) => sum + resolveRelevance(c), 0) /
    topChunks.length;
  const avgThreshold =
    topChunks.reduce(
      (sum, c) => sum + resolveThreshold(c.scoreScale, input),
      0,
    ) / topChunks.length;

  return avgScore >= avgThreshold * AVG_SCORE_THRESHOLD_RATIO;
}

export type EvidenceVerdict = "sufficient" | "ambiguous" | "insufficient";

export type EvidenceAssessmentInput = EvidencePolicyInput & {
  /** Top-3-mean bar for confident evidence, cross-encoder scale. */
  sufficientTop3Mean: number;
  /** The same bar on the heuristic-reranker scale. */
  sufficientTop3MeanHeuristic: number;
};

/**
 * Which score scale the assessed chunks actually carry. "mixed" happens on
 * cached pools written under a different reranker configuration; "unknown"
 * means no chunk carries a scoreScale at all (pre-instrumentation cache
 * entries), so the top-3 mean is being compared against a threshold whose
 * scale is a guess.
 */
export type EvidenceScaleComposition =
  "cross_encoder" | "heuristic" | "mixed" | "unknown";

export type EvidenceAssessment = {
  verdict: EvidenceVerdict;
  top1Relevance: number | null;
  top3MeanRelevance: number | null;
  scale: EvidenceScaleComposition;
};

/**
 * Three-way refinement of the binary evidence gate for the CRAG loop:
 *
 * - `insufficient` is exactly `!hasSufficientEvidence` — the refusal band is
 *   never widened or re-derived here, so enabling the loop cannot change
 *   which queries are refused outright.
 * - `sufficient` additionally requires the top-3 mean relevance to clear the
 *   per-chunk-scale `sufficientTop3Mean*` bar, averaged the same way the
 *   gate averages its own thresholds so mixed-scale cached pools behave
 *   sanely.
 * - everything between the two bands is `ambiguous`: answerable, but weakly
 *   enough that the loop's corrective measures apply.
 */
export function assessEvidence(
  input: EvidenceAssessmentInput,
): EvidenceAssessment {
  const topChunks = input.chunks.slice(0, Math.min(3, input.chunks.length));
  const top1Relevance =
    input.chunks.length > 0 ? resolveRelevance(input.chunks[0]!) : null;
  const top3MeanRelevance =
    topChunks.length > 0
      ? topChunks.reduce((sum, c) => sum + resolveRelevance(c), 0) /
        topChunks.length
      : null;

  const scales = new Set(
    input.chunks.map((chunk) => chunk.scoreScale).filter(Boolean),
  );
  const scale: EvidenceScaleComposition =
    scales.size === 0
      ? "unknown"
      : scales.size > 1
        ? "mixed"
        : scales.has("cross_encoder")
          ? "cross_encoder"
          : "heuristic";

  if (!hasSufficientEvidence(input)) {
    return { verdict: "insufficient", top1Relevance, top3MeanRelevance, scale };
  }

  const sufficientThreshold =
    topChunks.reduce(
      (sum, c) =>
        sum +
        (c.scoreScale === "cross_encoder"
          ? input.sufficientTop3Mean
          : input.sufficientTop3MeanHeuristic),
      0,
    ) / topChunks.length;

  return {
    verdict:
      top3MeanRelevance !== null && top3MeanRelevance >= sufficientThreshold
        ? "sufficient"
        : "ambiguous",
    top1Relevance,
    top3MeanRelevance,
    scale,
  };
}

/**
 * Indexes of chunks that individually meet their evidence threshold.
 *
 * Used by the web-augmented path when local evidence fails the gate: the
 * answer may proceed on web sources, but sub-threshold document chunks must
 * not travel into the prompt, where they would lend false authority to
 * irrelevant text. Returned as indexes so callers can filter parallel arrays
 * (sanitized prompt chunks vs. original attribution chunks) consistently.
 */
export function selectChunkIndexesMeetingThreshold(
  input: EvidencePolicyInput,
): number[] {
  return input.chunks.reduce<number[]>((kept, chunk, index) => {
    if (resolveRelevance(chunk) >= resolveThreshold(chunk.scoreScale, input)) {
      kept.push(index);
    }
    return kept;
  }, []);
}
