import { startActiveObservation } from "@langfuse/tracing";
import { env } from "@/lib/config/env";
import { getRuntimeSecrets } from "@/lib/runtime/secrets";

type EmbeddingApiResponse = {
  data?: Array<{
    embedding?: number[];
  }>;
  usage?: {
    prompt_tokens?: number;
  };
  error?: {
    message?: string;
  };
};

export async function createQueryEmbedding(
  normalizedQuery: string,
): Promise<number[]> {
  return startActiveObservation(
    "embed-query",
    async (observation) => {
      observation.update({
        input: normalizedQuery,
        model: env.RAG_QUERY_EMBEDDING_MODEL,
        modelParameters: { dimensions: env.RAG_QUERY_EMBEDDING_DIMENSIONS },
      });

      const { embedding, promptTokens } =
        await requestQueryEmbedding(normalizedQuery);

      // The vector itself is thousands of floats: unreadable in the UI and
      // pure payload weight. Its shape is the part worth seeing.
      observation.update({
        output: { dimensions: embedding.length },
        usageDetails: { input: promptTokens ?? 0 },
      });

      return embedding;
    },
    { asType: "embedding" },
  );
}

async function requestQueryEmbedding(
  normalizedQuery: string,
): Promise<{ embedding: number[]; promptTokens: number | undefined }> {
  const runtimeOpenAiApiKey = getRuntimeSecrets().openAiApiKey;
  const apiKey = runtimeOpenAiApiKey ?? env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No OpenAI API key available. Configure OPENAI_API_KEY or store a key in the BYOK vault.",
    );
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
      dimensions: env.RAG_QUERY_EMBEDDING_DIMENSIONS,
    }),
  });

  const payload = (await response.json()) as EmbeddingApiResponse;

  if (!response.ok) {
    const message =
      payload.error?.message ??
      `Embedding provider request failed (status=${response.status})`;
    throw new Error(message);
  }

  const embedding = payload.data?.[0]?.embedding;
  if (!embedding || embedding.length === 0) {
    throw new Error("Embedding provider returned an empty embedding");
  }

  return { embedding, promptTokens: payload.usage?.prompt_tokens };
}
