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
  });

  if (!response.ok) {
    throw new Error(`Tavily search failed: ${response.status}`);
  }

  const data = (await response.json()) as TavilyResponse;

  return (data.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content.slice(0, 500),
    relevanceScore: r.score,
  }));
}
