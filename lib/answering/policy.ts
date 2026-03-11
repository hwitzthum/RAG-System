import type { RetrievedChunk } from "@/lib/contracts/retrieval";

export type EvidencePolicyInput = {
  chunks: RetrievedChunk[];
  minEvidenceChunks: number;
  minRerankScore: number;
};

function resolveScore(chunk: RetrievedChunk): number {
  return chunk.rerankScore ?? chunk.retrievalScore;
}

export function hasSufficientEvidence(input: EvidencePolicyInput): boolean {
  if (input.chunks.length < Math.max(1, input.minEvidenceChunks)) {
    return false;
  }

  // At least one chunk must meet the minimum score threshold.
  const hasStrongChunk = input.chunks.some((chunk) => resolveScore(chunk) >= input.minRerankScore);
  if (!hasStrongChunk) {
    return false;
  }

  // The top chunks (up to minEvidenceChunks) must have a reasonable average score
  // to avoid answering when only one chunk is marginally relevant.
  // Set at half the per-chunk minimum: a strong lead chunk can compensate for weaker supporting ones.
  const AVG_SCORE_THRESHOLD_RATIO = 0.5;
  const topChunks = input.chunks.slice(0, Math.max(1, input.minEvidenceChunks));
  const avgScore = topChunks.reduce((sum, c) => sum + resolveScore(c), 0) / topChunks.length;
  return avgScore >= input.minRerankScore * AVG_SCORE_THRESHOLD_RATIO;
}
