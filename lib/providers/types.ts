import type { RetrievedChunk, SupportedLanguage } from "@/lib/contracts/retrieval";

export type RerankInput = {
  normalizedQuery: string;
  candidates: RetrievedChunk[];
  poolSize: number;
  topK: number;
};

export type LlmGenerateInput = {
  systemPrompt: string;
  userPrompt: string;
  language: SupportedLanguage;
  maxOutputTokens: number;
};

export interface EmbeddingProvider {
  createEmbedding(normalizedQuery: string): Promise<number[]>;
}

export interface RerankerProvider {
  rerank(input: RerankInput): Promise<RetrievedChunk[]>;
}

export interface LlmProvider {
  generateAnswer(input: LlmGenerateInput): Promise<string>;
}

export type ProviderRegistry = {
  embedding: EmbeddingProvider;
  reranker: RerankerProvider;
  llm: LlmProvider;
};
