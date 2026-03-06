export type SupportedLanguage = "EN" | "DE" | "FR" | "IT" | "ES";

export type RetrievalSource = "vector" | "keyword" | "hybrid";

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
  rerankScore?: number;
};

export type Citation = {
  documentId: string;
  pageNumber: number;
  chunkId: string;
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
