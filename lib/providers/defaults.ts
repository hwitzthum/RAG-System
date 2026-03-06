import { env } from "@/lib/config/env";
import { createQueryEmbedding } from "@/lib/retrieval/embedding";
import { rerankCandidates } from "@/lib/retrieval/reranker";
import { getRuntimeSecrets } from "@/lib/runtime/secrets";
import type { LlmGenerateInput, ProviderRegistry } from "@/lib/providers/types";

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
  };
};

async function generateOpenAiAnswer(input: LlmGenerateInput): Promise<string> {
  const runtimeOpenAiApiKey = getRuntimeSecrets().openAiApiKey;
  const apiKey = runtimeOpenAiApiKey ?? env.OPENAI_API_KEY;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: env.RAG_LLM_MODEL,
      temperature: 0,
      max_tokens: Math.max(64, input.maxOutputTokens),
      messages: [
        { role: "system", content: input.systemPrompt },
        {
          role: "user",
          content: `${input.userPrompt}\n\nOutput language: ${input.language}`,
        },
      ],
    }),
  });

  const payload = (await response.json()) as ChatCompletionResponse;
  if (!response.ok) {
    const message = payload.error?.message ?? `LLM provider request failed (status=${response.status})`;
    throw new Error(message);
  }

  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("LLM provider returned empty content");
  }

  return content;
}

let providers: ProviderRegistry | null = null;

export function getDefaultProviders(): ProviderRegistry {
  if (!providers) {
    providers = {
      embedding: {
        createEmbedding: createQueryEmbedding,
      },
      reranker: {
        async rerank(input) {
          return rerankCandidates(input);
        },
      },
      llm: {
        generateAnswer: generateOpenAiAnswer,
      },
    };
  }

  return providers;
}
