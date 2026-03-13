import { env } from "@/lib/config/env";
import { getRuntimeSecrets } from "@/lib/runtime/secrets";

type EmbeddingApiResponse = {
  data?: Array<{
    embedding?: number[];
  }>;
  error?: {
    message?: string;
  };
};

export async function createQueryEmbedding(normalizedQuery: string): Promise<number[]> {
  const runtimeOpenAiApiKey = getRuntimeSecrets().openAiApiKey;
  const apiKey = runtimeOpenAiApiKey ?? env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("No OpenAI API key available. Configure OPENAI_API_KEY or store a key in the BYOK vault.");
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: env.RAG_QUERY_EMBEDDING_MODEL,
      input: normalizedQuery,
    }),
  });

  const payload = (await response.json()) as EmbeddingApiResponse;

  if (!response.ok) {
    const message = payload.error?.message ?? `Embedding provider request failed (status=${response.status})`;
    throw new Error(message);
  }

  const embedding = payload.data?.[0]?.embedding;
  if (!embedding || embedding.length === 0) {
    throw new Error("Embedding provider returned an empty embedding");
  }

  return embedding;
}
