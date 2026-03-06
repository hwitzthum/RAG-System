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

  return input.chunks.some((chunk) => resolveScore(chunk) >= input.minRerankScore);
}
