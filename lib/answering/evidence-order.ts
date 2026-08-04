import { env } from "@/lib/config/env";
import type { RetrievedChunk } from "@/lib/contracts/retrieval";

/**
 * Lost-in-the-middle mitigation: LLMs attend most reliably to the beginning
 * and end of their context, so the strongest evidence should sit at both
 * edges of the prompt, not stacked at the top with the weakest trailing last.
 *
 * Works at the document-group level to preserve contextual grouping: chunks
 * from the same document stay together in their existing order (score order
 * with page-adjacent chunks clustered); the groups themselves are placed
 * ends-first — strongest group opens the context, second-strongest closes
 * it, weaker groups fill the middle.
 *
 * Returns a permutation of indexes so callers can reorder parallel arrays
 * (sanitized prompt chunks vs. attribution chunks) consistently. Citation
 * indexes are assigned from the reordered list, so [n] markers stay aligned
 * automatically.
 */
export function orderEvidenceIndexes(chunks: RetrievedChunk[]): number[] {
  const identity = chunks.map((_, index) => index);
  if (env.RAG_EVIDENCE_PLACEMENT !== "ends" || chunks.length <= 2) {
    return identity;
  }

  const groupsInOrder: number[][] = [];
  const groupByDocument = new Map<string, number[]>();
  chunks.forEach((chunk, index) => {
    let group = groupByDocument.get(chunk.documentId);
    if (!group) {
      group = [];
      groupByDocument.set(chunk.documentId, group);
      groupsInOrder.push(group);
    }
    group.push(index);
  });

  if (groupsInOrder.length === 1) {
    // Single document: alternate individual chunks instead, so the strongest
    // chunk still bookends the context.
    return alternateEndsFirst(identity.map((index) => [index]));
  }

  const groupScore = (group: number[]): number =>
    Math.max(
      ...group.map(
        (index) => chunks[index]!.rerankScore ?? chunks[index]!.retrievalScore,
      ),
    );

  const sortedGroups = [...groupsInOrder].sort(
    (left, right) => groupScore(right) - groupScore(left),
  );

  return alternateEndsFirst(sortedGroups);
}

function alternateEndsFirst(sortedGroups: number[][]): number[] {
  const front: number[][] = [];
  const back: number[][] = [];
  sortedGroups.forEach((group, position) => {
    (position % 2 === 0 ? front : back).push(group);
  });
  return [...front, ...back.reverse()].flat();
}
