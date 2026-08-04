export type SupportedLanguage = "EN" | "DE" | "FR" | "IT" | "ES";

export type RetrievalSource = "vector" | "keyword" | "hybrid";

/**
 * Which scoring scheme produced a chunk's `relevanceScore`. The heuristic
 * reranker and the Cohere cross-encoder emit numbers on different scales, so
 * the evidence-sufficiency gate has to know which one it is reading before it
 * can compare against a threshold.
 */
export type RelevanceScoreScale = "heuristic" | "cross_encoder";

export type RetrievedChunk = {
  chunkId: string;
  documentId: string;
  pageNumber: number;
  sectionTitle: string;
  content: string;
  context: string;
  language: SupportedLanguage;
  source: RetrievalSource;
  retrievalScore: number;
  vectorScore?: number;
  keywordScore?: number;
  vectorRank?: number;
  keywordRank?: number;
  /**
   * Ordering score. Pool-relative: it is normalised against the best candidate
   * in the current rerank pool and receives positional boosts (e.g. contextual
   * grouping). Use it to sort, never to decide whether evidence is good enough.
   */
  rerankScore?: number;
  /**
   * Absolute relevance in [0, 1], independent of the rest of the pool. This is
   * the only score the evidence-sufficiency gate may read — `rerankScore`
   * always puts the pool's best candidate near 1.0 regardless of how weak it
   * actually is.
   */
  relevanceScore?: number;
  scoreScale?: RelevanceScoreScale;
};

export type Citation = {
  documentId: string;
  pageNumber: number;
  chunkId: string;
  /**
   * 1-based index of the evidence chunk as presented to the model, matching the
   * `[n]` markers it writes inline. Optional because rows persisted to
   * `query_history.citations` before citation attribution existed do not carry
   * it.
   */
  evidenceIndex?: number;
};

export type RetrievalTrace = {
  normalizedQuery: string;
  language: SupportedLanguage;
  cacheKey: string;
  cacheHit: boolean;
  retrievalVersion: number;
  topK: number;
  candidateCounts: {
    vector: number;
    keyword: number;
    fused: number;
    reranked: number;
  };
};
