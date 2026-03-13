import type { RetrievedChunk } from "@/lib/contracts/retrieval";
import { CohereClient } from "cohere-ai";
import { env } from "@/lib/config/env";

export type CrossEncoderInput = {
  query: string;
  chunks: RetrievedChunk[];
  model: string;
  topK: number;
};

const CROSS_ENCODER_POOL_CAP = 20;

export async function crossEncoderRerank(input: CrossEncoderInput): Promise<RetrievedChunk[]> {
  if (input.chunks.length === 0) {
    return [];
  }

  if (!env.COHERE_API_KEY) {
    return input.chunks.slice(0, input.topK);
  }

  const cappedChunks = input.chunks.slice(0, CROSS_ENCODER_POOL_CAP);

  const documents = cappedChunks.map(
    (chunk) => `${chunk.sectionTitle}\n${chunk.content}`.slice(0, 4096),
  );

  try {
    const cohere = new CohereClient({ token: env.COHERE_API_KEY });

    const response = await cohere.v2.rerank({
      model: input.model,
      query: input.query,
      documents,
      topN: input.topK,
    });

    return response.results.map((result) => ({
      ...cappedChunks[result.index],
      rerankScore: result.relevanceScore,
    }));
  } catch (error) {
    console.warn("Cohere rerank failed, falling back to original order:", error);
    return cappedChunks.slice(0, input.topK);
  }
}
