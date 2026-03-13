import { getDefaultProviders } from "@/lib/providers/defaults";
import { env } from "@/lib/config/env";

const MULTI_QUERY_TIMEOUT_MS = 4000;

export async function generateQueryVariations(originalQuery: string): Promise<string[]> {
  const variationCount = env.RAG_MULTI_QUERY_VARIATIONS;

  const systemPrompt =
    "You generate alternative search queries to improve document retrieval. " +
    "Return ONLY a JSON array of strings. No explanation.";

  const userPrompt =
    `Generate ${variationCount} alternative search queries for the following query. ` +
    `Each variation should rephrase or expand the original while preserving intent.\n\n` +
    `Original query: "${originalQuery}"`;

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Multi-query generation timeout")), MULTI_QUERY_TIMEOUT_MS);
  });

  let raw: string;
  try {
    raw = await Promise.race([
      getDefaultProviders().llm.generateAnswer({
        systemPrompt,
        userPrompt,
        language: "EN",
        maxOutputTokens: 300,
      }),
      timeout,
    ]);
  } catch {
    return [originalQuery];
  } finally {
    clearTimeout(timer!);
  }

  try {
    const jsonMatch = raw.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return [originalQuery];
    const variations = JSON.parse(jsonMatch[0]) as unknown[];
    const valid = variations
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v !== originalQuery.toLowerCase());
    const unique = [...new Set(valid)].slice(0, variationCount);
    return [originalQuery, ...unique];
  } catch {
    return [originalQuery];
  }
}
