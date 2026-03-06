import type { RetrievedChunk } from "@/lib/contracts/retrieval";

type RankSource = "vector" | "keyword";

type ReciprocalRankFusionInput = {
  vectorCandidates: RetrievedChunk[];
  keywordCandidates: RetrievedChunk[];
  rrfK: number;
};

export function reciprocalRankFusion(input: ReciprocalRankFusionInput): RetrievedChunk[] {
  const rrfK = Math.max(1, input.rrfK);
  const combined = new Map<string, RetrievedChunk>();

  const applyRankedList = (candidates: RetrievedChunk[], source: RankSource) => {
    candidates.forEach((candidate, index) => {
      const rank = index + 1;
      const contribution = 1 / (rrfK + rank);
      const existing = combined.get(candidate.chunkId);

      const merged: RetrievedChunk = existing
        ? { ...existing, retrievalScore: existing.retrievalScore + contribution, source: "hybrid" }
        : { ...candidate, retrievalScore: contribution, source };

      if (source === "vector") {
        merged.vectorRank = rank;
        merged.vectorScore = candidate.retrievalScore;
      } else {
        merged.keywordRank = rank;
        merged.keywordScore = candidate.retrievalScore;
      }

      combined.set(candidate.chunkId, merged);
    });
  };

  applyRankedList(input.vectorCandidates, "vector");
  applyRankedList(input.keywordCandidates, "keyword");

  return [...combined.values()].sort((left, right) => right.retrievalScore - left.retrievalScore);
}
