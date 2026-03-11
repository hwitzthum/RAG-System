import { env } from "@/lib/config/env";
import { searchTavily } from "./tavily-client";
import type { WebSource } from "./types";

const MIN_RELEVANCE_SCORE = 0.5;

export async function performWebResearch(query: string): Promise<WebSource[]> {
  if (!env.RAG_WEB_SEARCH_ENABLED || !env.RAG_WEB_SEARCH_API_KEY) {
    return [];
  }

  const sources = await searchTavily(
    query,
    env.RAG_WEB_SEARCH_API_KEY,
    env.RAG_WEB_SEARCH_MAX_RESULTS,
  );

  return sources.filter((s) => s.relevanceScore >= MIN_RELEVANCE_SCORE);
}
