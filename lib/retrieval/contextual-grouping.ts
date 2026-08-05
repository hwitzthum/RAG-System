import type { RetrievedChunk } from "@/lib/contracts/retrieval";

// Additive, per adjacent neighbour. A multiplicative variant
// (`base * (1 + 0.08 * neighbours)`) was tried and reverted after measurement:
// nDCG@10 fell 0.8168 -> 0.7989 overall and 0.6195 -> 0.5757 on EN
// (benchmark-2026-08-04T20-47-41-690Z vs -T12-35-17-329Z; recall@5 and DE were
// unchanged). `rerankScore` is pool-normalised, so top-of-pool candidates sit
// near 0.95 and an 8% boost is worth ~0.076 there -- LARGER than the flat 0.05
// it replaced, and applied exactly where nDCG@10 is measured.
//
// The genuine defect this exposed is the adjacency key, not the arithmetic:
// pages are compared with a <= 1 gap, so several chunks retrieved from the SAME
// page all boost each other and interior ones in the sort order boost twice.
// Fixing that means keying on chunk_index, which needs a column on two SQL
// RETURNS TABLE signatures and the RetrievedChunk contract. Do not re-tune this
// constant without an nDCG@10 sweep.
//
// Wave 4 made the magnitude a parameter (env RAG_ADJACENCY_BOOST, passed by
// the caller so this module stays env-free): with cross-encoder rank gaps of
// 0.01–0.05, a 0.05-per-neighbour boost can leapfrog a genuine relevance
// preference, and the same-page defect above scales with it.
const ADJACENCY_BOOST = 0.05;

export function applyContextualGrouping(
  chunks: RetrievedChunk[],
  adjacencyBoost: number = ADJACENCY_BOOST,
): RetrievedChunk[] {
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
        boost += adjacencyBoost;
      }
      if (
        i < sorted.length - 1 &&
        sorted[i + 1].pageNumber - sorted[i].pageNumber <= 1
      ) {
        boost += adjacencyBoost;
      }

      // Boost the ordering score only. `relevanceScore` is deliberately left
      // alone: page adjacency says something about presentation order, nothing
      // about whether a chunk answers the query. Folding it into the score the
      // evidence gate reads made weak evidence look stronger purely because it
      // happened to sit next to another retrieved chunk.
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
