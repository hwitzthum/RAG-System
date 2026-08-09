import { updateActiveObservation } from "@langfuse/tracing";
import { env } from "@/lib/config/env";
import { createQueryEmbedding } from "@/lib/retrieval/embedding";
import { rerankCandidates } from "@/lib/retrieval/reranker";
import { getRuntimeSecrets } from "@/lib/runtime/secrets";
import type {
  LlmGenerateInput,
  LlmGenerateResult,
  ProviderRegistry,
} from "@/lib/providers/types";

type OpenAiUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
    /** "stop" | "length" | "content_filter" | ... — "length" means truncated. */
    finish_reason?: string | null;
  }>;
  usage?: OpenAiUsage;
  error?: {
    message?: string;
  };
};

/**
 * Records model, parameters and token usage on whichever `generation`
 * observation the caller opened around this request.
 *
 * Attributes are attached here rather than at the call sites so that every
 * consumer of the shared LLM provider (answer generation, query
 * decomposition, multi-query expansion, HyDE, citation verification) gets
 * cost tracking from one place. Call sites stay responsible for the
 * observation's name and its input/output, which is what makes them
 * filterable in Langfuse. No-op when tracing is disabled.
 */
function recordGenerationUsage(
  input: LlmGenerateInput,
  usage: OpenAiUsage | undefined,
): void {
  updateActiveObservation(
    {
      model: env.RAG_LLM_MODEL,
      modelParameters: {
        temperature: 0,
        max_tokens: Math.max(64, input.maxOutputTokens),
      },
      ...(usage
        ? {
            usageDetails: {
              input: usage.prompt_tokens ?? 0,
              output: usage.completion_tokens ?? 0,
              ...(usage.prompt_tokens_details?.cached_tokens
                ? {
                    cache_read_input_tokens:
                      usage.prompt_tokens_details.cached_tokens,
                  }
                : {}),
            },
          }
        : {}),
    },
    { asType: "generation" },
  );
}

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

  recordGenerationUsage(input, payload.usage);

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
      // Without this a streamed completion reports no token counts at all,
      // leaving the streaming answer path — the most expensive call in the
      // system — with no cost attribution in Langfuse.
      stream_options: { include_usage: true },
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
  let usage: OpenAiUsage | undefined;
  let completionStartTime: Date | undefined;

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
          usage?: OpenAiUsage;
        };
        // Sent once, on a trailing chunk that carries an empty choices array.
        if (parsed.usage) {
          usage = parsed.usage;
        }
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          completionStartTime ??= new Date();
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

  recordGenerationUsage(input, usage);
  if (completionStartTime) {
    // Time to first token — the latency the user actually perceives on the
    // streamed path, distinct from the span's total duration.
    updateActiveObservation({ completionStartTime }, { asType: "generation" });
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
