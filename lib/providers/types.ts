import type {
  RetrievedChunk,
  SupportedLanguage,
} from "@/lib/contracts/retrieval";

export type RerankInput = {
  normalizedQuery: string;
  candidates: RetrievedChunk[];
  poolSize: number;
  language?: SupportedLanguage;
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
  /**
   * Optional streaming variant: emits raw token deltas and resolves with the
   * complete text. Absent on providers that cannot stream; callers fall back
   * to generateAnswer.
   */
  generateAnswerStream?(
    input: LlmGenerateInput,
    onDelta: (text: string) => void,
  ): Promise<string>;
}

export type ProviderRegistry = {
  embedding: EmbeddingProvider;
  reranker: RerankerProvider;
  llm: LlmProvider;
};
