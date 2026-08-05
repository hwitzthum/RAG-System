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

export type LlmGenerateResult = {
  text: string;
  /**
   * The provider stopped because it hit the output-token ceiling, not because
   * the answer was finished. A truncated answer is a mid-sentence cut-off with
   * a possibly dangling [n] marker — it must not be presented as complete, and
   * the LLM judge must not score its severed final sentence as unsupported.
   */
  truncated: boolean;
};

export interface LlmProvider {
  generateAnswer(input: LlmGenerateInput): Promise<LlmGenerateResult>;
  /**
   * Optional streaming variant: emits raw token deltas and resolves with the
   * complete text. Absent on providers that cannot stream; callers fall back
   * to generateAnswer.
   */
  generateAnswerStream?(
    input: LlmGenerateInput,
    onDelta: (text: string) => void,
  ): Promise<LlmGenerateResult>;
}

export type ProviderRegistry = {
  embedding: EmbeddingProvider;
  reranker: RerankerProvider;
  llm: LlmProvider;
};
