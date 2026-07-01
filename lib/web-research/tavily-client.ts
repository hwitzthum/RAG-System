import type { WebSource } from "./types";

type TavilySearchResult = {
  title: string;
  url: string;
  content: string;
  score: number;
};

type TavilyResponse = {
  results: TavilySearchResult[];
};

/**
 * Validates that a URL uses a safe scheme (http or https only).
 * Rejects javascript:, data:, vbscript:, file:, and any other scheme
 * that could execute code or access local resources when followed in
 * an anchor tag.
 */
function isSafeWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export async function searchTavily(
  query: string,
  apiKey: string,
  maxResults: number,
): Promise<WebSource[]> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: "basic",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Tavily search failed: ${response.status}`);
  }

  const data = (await response.json()) as TavilyResponse;

  return (data.results ?? [])
    .filter((r) => isSafeWebUrl(r.url))
    .map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content.slice(0, 500),
      relevanceScore: r.score,
    }));
}
