import { LangfuseClient } from "@langfuse/client";
import type { ChatPromptClient } from "@langfuse/client";

/**
 * Structural match for the SDK's `ChatMessage`, which `@langfuse/client` uses
 * in its signatures but does not re-export. Declared here rather than reaching
 * into `@langfuse/core` so this file depends only on the package it imports.
 */
type ChatMessage = { role: string; content: string };

/**
 * Resolves the answering prompts from Langfuse Prompt Management, falling back
 * to the in-code templates.
 *
 * The fallback is the point of this module. Answering is the critical path of
 * the whole product, so a Langfuse outage, a missing credential, or a prompt
 * that has not been seeded yet must all degrade to exactly the behaviour the
 * application had before prompts were externalised — never to a failed answer.
 * The in-code templates in lib/answering/prompts.ts remain a complete,
 * runnable copy for precisely that reason.
 */

/**
 * Prompt names are an API: Langfuse looks prompts up by name, and renaming one
 * silently sends every request down the fallback path instead of failing.
 */
export const GROUNDED_ANSWER_PROMPT_NAME = "grounded-answer";
export const WEB_AUGMENTED_PROMPT_NAME = "web-augmented-answer";

export type ResolvedPrompt = {
  systemPrompt: string;
  userPrompt: string;
  /**
   * The managed prompt, for linking to the generation observation so a trace
   * records which prompt version produced it. Null whenever the fallback was
   * used — linking then would attribute the answer to a version that did not
   * actually run.
   */
  prompt: ChatPromptClient | null;
};

/**
 * Matches Langfuse's own default. Long enough that steady-state traffic almost
 * never pays a fetch, short enough that editing a prompt in the UI takes
 * effect within a minute — which is the reason to manage prompts there at all.
 */
const PROMPT_CACHE_TTL_SECONDS = 60;

/** Bounds the added latency on a cold cache; the fallback covers a timeout. */
const PROMPT_FETCH_TIMEOUT_MS = 4_000;

function hasCredentials(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim(),
  );
}

let client: LangfuseClient | null = null;

function getClient(): LangfuseClient | null {
  if (!hasCredentials()) {
    return null;
  }
  client ??= new LangfuseClient();
  return client;
}

/**
 * Local stand-in for Langfuse's `{{variable}}` substitution, used only on the
 * no-credentials path. A replacer function (rather than a string replacement)
 * keeps `$&`-style sequences in evidence text from being interpreted.
 */
function compileTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in variables ? variables[name]! : match,
  );
}

/**
 * A managed prompt is a message array, but the LLM provider contract takes a
 * system string and a user string. System messages are joined into the former
 * and everything else into the latter, so adding a message in the Langfuse UI
 * changes the prompt rather than silently disappearing.
 */
function splitMessages(messages: ChatMessage[]): {
  systemPrompt: string;
  userPrompt: string;
} {
  const system: string[] = [];
  const user: string[] = [];

  for (const message of messages) {
    (message.role === "system" ? system : user).push(message.content);
  }

  return {
    systemPrompt: system.join("\n\n"),
    userPrompt: user.join("\n\n"),
  };
}

export async function resolveAnswerPrompt(input: {
  name: string;
  fallback: ChatMessage[];
  variables: Record<string, string>;
}): Promise<ResolvedPrompt> {
  const langfuse = getClient();

  if (!langfuse) {
    return {
      ...splitMessages(
        input.fallback.map((message) => ({
          ...message,
          content: compileTemplate(message.content, input.variables),
        })),
      ),
      prompt: null,
    };
  }

  try {
    const prompt = await langfuse.prompt.get(input.name, {
      type: "chat",
      label: "production",
      fallback: input.fallback,
      cacheTtlSeconds: PROMPT_CACHE_TTL_SECONDS,
      fetchTimeoutMs: PROMPT_FETCH_TIMEOUT_MS,
    });

    return {
      ...splitMessages(prompt.compile(input.variables) as ChatMessage[]),
      prompt: prompt.isFallback ? null : prompt,
    };
  } catch (error) {
    // The SDK already falls back internally; this catches anything it does not
    // (client construction, an unexpected payload shape). Answering must not
    // fail because prompt management is unavailable.
    console.warn(
      "langfuse_prompt_resolve_failed",
      input.name,
      error instanceof Error ? error.message : String(error),
    );

    return {
      ...splitMessages(
        input.fallback.map((message) => ({
          ...message,
          content: compileTemplate(message.content, input.variables),
        })),
      ),
      prompt: null,
    };
  }
}
