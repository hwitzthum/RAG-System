import type { RetrievedChunk } from "@/lib/contracts/retrieval";

/**
 * Compact chunk representations for trace payloads.
 *
 * Retrieval stages run over pools of up to 100 candidates, and a query passes
 * through several of them (vector, keyword, fusion, rerank, cross-encode,
 * grouping, diversity). Emitting full chunk bodies at each stage would repeat
 * the same corpus text many times over in a single trace — expensive to ship
 * and unreadable in the UI.
 *
 * The text is not lost: the chunks that actually reach the model appear
 * verbatim in the answer generation's prompt, which is where reading them is
 * useful. Everything upstream of that is about *ranking*, so scores and
 * identity are what a reviewer needs.
 */

export type TracedChunkSummary = {
  chunkId: string;
  documentId: string;
  pageNumber: number;
  sectionTitle: string;
  retrievalScore: number;
  rerankScore?: number;
  relevanceScore?: number;
  scoreScale?: string;
};

/** Metadata-only view of a chunk: identity and scores, no body text. */
export function summarizeChunk(chunk: RetrievedChunk): TracedChunkSummary {
  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    pageNumber: chunk.pageNumber,
    sectionTitle: chunk.sectionTitle,
    retrievalScore: chunk.retrievalScore,
    ...(chunk.rerankScore === undefined
      ? {}
      : { rerankScore: chunk.rerankScore }),
    ...(chunk.relevanceScore === undefined
      ? {}
      : { relevanceScore: chunk.relevanceScore }),
    ...(chunk.scoreScale === undefined ? {} : { scoreScale: chunk.scoreScale }),
  };
}

/**
 * `limit` caps how many candidates are described individually. Ranking bugs
 * live at the head of the list, so the head is what gets kept; the rest are
 * reported as a count so truncation is never silent.
 */
export function summarizeChunks(
  chunks: readonly RetrievedChunk[],
  limit = 20,
): { count: number; omitted: number; chunks: TracedChunkSummary[] } {
  return {
    count: chunks.length,
    omitted: Math.max(0, chunks.length - limit),
    chunks: chunks.slice(0, limit).map(summarizeChunk),
  };
}
