import type { RetrievedChunk } from "@/lib/contracts/retrieval";

export type DocumentDiversityOptions = {
  topK: number;
  /** Max chunks one document may hold in the topK window. 0 disables. */
  maxPerDocument: number;
  /**
   * Absolute cross-encoder relevance a chunk from another document must reach
   * to claim a reserved slot. Aligned with the evidence gate's cross-encoder
   * threshold so a promoted chunk is never gate-failing evidence.
   */
  relevanceFloor: number;
};

/**
 * Soft per-document cap over the final topK window. Cross-document multi-hop
 * queries were observed returning 8-of-8 chunks from a single document while
 * the second golden document sat just outside the window; contextual grouping
 * actively concentrates results, so this stage runs after it and pushes back.
 *
 * Greedy, order-preserving: chunks are taken in ranked order until a document
 * exceeds its cap; its surplus chunks are deferred. A reserved slot is filled
 * only by an alternate-document chunk that carries a cross-encoder-scale
 * `relevanceScore` at or above the floor — heuristic-scale overflow chunks are
 * never promoted, because their scores are not comparable. When no qualifier
 * exists, deferred chunks backfill in original order, so a legitimately
 * single-document query degrades to a no-op.
 *
 * Scores are never mutated; only membership and order of the returned list
 * change. The caller slices to topK afterwards, matching the contextual
 * grouping contract.
 */
export function applyDocumentDiversity(
  chunks: RetrievedChunk[],
  options: DocumentDiversityOptions,
): RetrievedChunk[] {
  const { topK, maxPerDocument, relevanceFloor } = options;
  if (maxPerDocument <= 0 || chunks.length <= topK) {
    return chunks;
  }

  const selected: RetrievedChunk[] = [];
  const deferred: RetrievedChunk[] = [];
  const perDocument = new Map<string, number>();

  for (const [index, chunk] of chunks.entries()) {
    if (selected.length >= topK) {
      break;
    }
    const held = perDocument.get(chunk.documentId) ?? 0;
    if (held >= maxPerDocument) {
      deferred.push(chunk);
      continue;
    }
    // A chunk inside the natural topK window earned its slot by rank. A chunk
    // beyond it is only here because the cap opened a reserved slot, and must
    // qualify: cross-encoder-scored at or above the floor.
    if (
      index >= topK &&
      (chunk.scoreScale !== "cross_encoder" ||
        (chunk.relevanceScore ?? 0) < relevanceFloor)
    ) {
      continue;
    }
    perDocument.set(chunk.documentId, held + 1);
    selected.push(chunk);
  }

  // No qualifier for a reserved slot: backfill with the deferred same-document
  // chunks in their original order — the cap must never shrink the window.
  let deferredIndex = 0;
  while (selected.length < topK && deferredIndex < deferred.length) {
    selected.push(deferred[deferredIndex]!);
    deferredIndex += 1;
  }

  const selectedSet = new Set(selected);
  const rest = chunks.filter((chunk) => !selectedSet.has(chunk));
  return [...selected, ...rest];
}
