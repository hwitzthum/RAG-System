import { env } from "@/lib/config/env";
import type { SupportedLanguage } from "@/lib/contracts/retrieval";
import { getDefaultProviders } from "@/lib/providers/defaults";

const HYDE_TIMEOUT_MS = 4000;

export async function generateHypotheticalDocument(input: {
  query: string;
  language: SupportedLanguage;
}): Promise<string | null> {
  const systemPrompt =
    "You generate a concise hypothetical answer passage for retrieval augmentation. " +
    "Write only the passage, with no bullet list, no preamble, and no markdown.";

  const userPrompt =
    `Write a short passage that would likely answer this information need across multiple documents.\n\n` +
    `Query: "${input.query}"\n\n` +
    "Focus on likely concepts, terminology, and relationships. Keep it factual in tone and under 140 words.";

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("HyDE generation timeout")), HYDE_TIMEOUT_MS);
  });

  try {
    const raw = await Promise.race([
      getDefaultProviders().llm.generateAnswer({
        systemPrompt,
        userPrompt,
        language: input.language,
        maxOutputTokens: Math.min(env.RAG_LLM_MAX_OUTPUT_TOKENS, 220),
      }),
      timeout,
    ]);

    const hypothesis = raw.trim();
    return hypothesis.length > 0 ? hypothesis : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer!);
  }
}
