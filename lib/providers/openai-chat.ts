/**
 * Model-dependent Chat Completions parameters, shared by every OpenAI call
 * site so that a model change is a config change, not a code change.
 *
 * gpt-6-luna and gpt-6-sol are reasoning models whose default effort is
 * `medium`, and at that effort they reject any `temperature` other than 1.
 * Effort `none` keeps them fast, deterministic-sampling models like the
 * gpt-4o / gpt-4.1 family they replace. Those older models reject
 * `reasoning_effort` outright, and gpt-6.1-sol rejects `none`, so it is sent
 * only to models that accept it — an env override to any other model must
 * keep working.
 *
 * `max_completion_tokens` replaces `max_tokens`, which reasoning models
 * reject; every current chat model accepts it.
 *
 * The returned object doubles as the Langfuse `modelParameters`, so traces
 * record what was actually sent.
 */
export type OpenAiChatParams = {
  reasoning_effort?: "none";
  service_tier?: "fast";
  temperature: number;
  max_completion_tokens: number;
};

// Matched as "<prefix>" or "<prefix>-…": "gpt-6-sol" must not catch
// "gpt-6.1-sol", which rejects effort `none`.
const REASONING_EFFORT_NONE_MODELS = ["gpt-6-luna", "gpt-6-sol"];

/*
 * Fast mode (formerly "priority" processing) halves gpt-6-luna's time to first
 * token on answer-sized prompts (measured ~1.6s -> ~0.65s) at twice the
 * per-token price. It is limited to gpt-6-luna: on gpt-6-sol it costs $4/$20
 * per 1M tokens, and the verifier already finishes well inside its timeout.
 */
const FAST_MODE_MODELS = ["gpt-6-luna"];

function matchesModel(model: string, families: string[]): boolean {
  return families.some(
    (family) => model === family || model.startsWith(`${family}-`),
  );
}

export function openAiChatParams(input: {
  model: string;
  maxCompletionTokens: number;
  temperature?: number;
  /** Request Fast mode where the model supports it; ignored elsewhere. */
  fastMode?: boolean;
}): OpenAiChatParams {
  return {
    ...(matchesModel(input.model, REASONING_EFFORT_NONE_MODELS)
      ? { reasoning_effort: "none" as const }
      : {}),
    ...(input.fastMode && matchesModel(input.model, FAST_MODE_MODELS)
      ? { service_tier: "fast" as const }
      : {}),
    temperature: input.temperature ?? 0,
    max_completion_tokens: input.maxCompletionTokens,
  };
}
