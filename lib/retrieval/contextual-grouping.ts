import type { RetrievedChunk } from "@/lib/contracts/retrieval";

const ADJACENCY_BOOST = 0.05;

export function applyContextualGrouping(chunks: RetrievedChunk[]): RetrievedChunk[] {
  if (chunks.length <= 1) {
    return chunks;
  }

  const byDocument = new Map<string, RetrievedChunk[]>();
  for (const chunk of chunks) {
    const group = byDocument.get(chunk.documentId) ?? [];
    group.push(chunk);
    byDocument.set(chunk.documentId, group);
  }

  const boosted: RetrievedChunk[] = [];

  for (const [, group] of byDocument) {
    const sorted = [...group].sort((a, b) => a.pageNumber - b.pageNumber);

    for (let i = 0; i < sorted.length; i++) {
      let boost = 0;

      if (i > 0 && sorted[i].pageNumber - sorted[i - 1].pageNumber <= 1) {
        boost += ADJACENCY_BOOST;
      }
      if (i < sorted.length - 1 && sorted[i + 1].pageNumber - sorted[i].pageNumber <= 1) {
        boost += ADJACENCY_BOOST;
      }

      const baseScore = sorted[i].rerankScore ?? sorted[i].retrievalScore;
      boosted.push({
        ...sorted[i],
        rerankScore: baseScore + boost,
      });
    }
  }

  boosted.sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
  return boosted;
}
