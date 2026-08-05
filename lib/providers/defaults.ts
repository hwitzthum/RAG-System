import { env } from "@/lib/config/env";
import { createQueryEmbedding } from "@/lib/retrieval/embedding";
import { rerankCandidates } from "@/lib/retrieval/reranker";
import { getRuntimeSecrets } from "@/lib/runtime/secrets";
import type {
  LlmGenerateInput,
  LlmGenerateResult,
  ProviderRegistry,
} from "@/lib/providers/types";

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
    /** "stop" | "length" | "content_filter" | ... — "length" means truncated. */
    finish_reason?: string | null;
  }>;
  error?: {
    message?: string;
  };
};

async function generateOpenAiAnswer(
  input: LlmGenerateInput,
): Promise<LlmGenerateResult> {
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
    const message =
      payload.error?.message ??
      `LLM provider request failed (status=${response.status})`;
    throw new Error(message);
  }

  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("LLM provider returned empty content");
  }

  return {
    text: content,
    truncated: payload.choices?.[0]?.finish_reason === "length",
  };
}

/**
 * Streaming variant: emits token deltas via onDelta as they arrive and
 * resolves with the complete answer text. Callers buffer deltas into
 * sentences and run per-sentence redaction before anything reaches a client.
 */
async function generateOpenAiAnswerStream(
  input: LlmGenerateInput,
  onDelta: (text: string) => void,
): Promise<LlmGenerateResult> {
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
      stream: true,
      messages: [
        { role: "system", content: input.systemPrompt },
        {
          role: "user",
          content: `${input.userPrompt}\n\nOutput language: ${input.language}`,
        },
      ],
    }),
  });

  if (!response.ok || !response.body) {
    let message = `LLM provider request failed (status=${response.status})`;
    try {
      const payload = (await response.json()) as ChatCompletionResponse;
      message = payload.error?.message ?? message;
    } catch {
      // Non-JSON error body; keep the status message.
    }
    throw new Error(message);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffered = "";
  let fullText = "";
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffered += decoder.decode(value, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newlineIndex).trim();
      buffered = buffered.slice(newlineIndex + 1);
      if (!line.startsWith("data:")) {
        continue;
      }
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        continue;
      }
      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{
            delta?: { content?: string | null };
            finish_reason?: string | null;
          }>;
        };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          onDelta(delta);
        }
        // Arrives on the final chunk of the stream, alongside an empty delta.
        if (parsed.choices?.[0]?.finish_reason === "length") {
          truncated = true;
        }
      } catch {
        // Partial SSE frame; ignore malformed line.
      }
    }
  }

  const content = fullText.trim();
  if (!content) {
    throw new Error("LLM provider returned empty content");
  }

  return { text: content, truncated };
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
        generateAnswerStream: generateOpenAiAnswerStream,
      },
    };
  }

  return providers;
}
