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
function resolveRelevance(chunk: RetrievedChunk): number {
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
