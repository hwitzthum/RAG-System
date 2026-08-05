import { getDefaultProviders } from "@/lib/providers/defaults";
import { env } from "@/lib/config/env";
import type { SupportedLanguage } from "@/lib/contracts/retrieval";

const DECOMPOSITION_TIMEOUT_MS = 4000;

/**
 * Queries below this word count skip the LLM call entirely. Genuinely blended
 * multi-topic questions are long — the shortest multi-hop query in the golden
 * set is 20 words — while short queries paying a ~1.2s LLM round-trip was the
 * measured driver of the arm-1 p50 latency regression (Wave 5 A/B,
 * benchmark-2026-08-05T20-33-31-181Z).
 */
const MIN_DECOMPOSABLE_WORDS = 12;

export type DecompositionDependencies = {
  generateAnswer: (input: {
    systemPrompt: string;
    userPrompt: string;
    language: SupportedLanguage;
    maxOutputTokens: number;
  }) => Promise<{ text: string }>;
};

/**
 * Split a blended multi-topic query into self-contained per-topic sub-queries
 * (Wave 5). Returns `[]` — meaning "do not decompose" — for short or
 * single-topic queries, on LLM timeout or unparseable output, or when fewer
 * than two valid sub-queries survive validation: a single sub-query is a
 * paraphrase, not a decomposition, and the multi-query path already owns
 * paraphrasing.
 *
 * Each sub-query is later retrieved and cross-encoder-reranked independently,
 * so the split targets queries whose topics live in different documents — the
 * shape where a blended query text compresses the cross-encoder's scores and
 * the second topic's evidence never reaches the window.
 */
export async function decomposeQuery(
  originalQuery: string,
  language: SupportedLanguage = "EN",
  overrides: Partial<DecompositionDependencies> = {},
): Promise<string[]> {
  if (originalQuery.trim().split(/\s+/).length < MIN_DECOMPOSABLE_WORDS) {
    return [];
  }

  const maxSubQueries = env.RAG_QUERY_DECOMPOSITION_MAX_SUBQUERIES;
  const generateAnswer =
    overrides.generateAnswer ?? getDefaultProviders().llm.generateAnswer;

  const systemPrompt =
    "You split blended search queries for a document retrieval system. " +
    "Return ONLY a JSON array of strings. No explanation, no markdown, no " +
    "code fences.";

  // Rules 4 and 5 are load-bearing and came from measured failures (arm 1 of
  // the Wave 5 A/B): the model split one query along an enumeration of groups
  // while keeping the blended frame in every sub-query, and restated another
  // query whole as its own first sub-query.
  const userPrompt =
    `Decide whether this query blends TWO OR MORE DISTINCT topics that would ` +
    `likely be covered by DIFFERENT documents (e.g. "How does X in domain A ` +
    `relate to Y in domain B?").\n\n` +
    `Rules:\n` +
    `1. Single topic — even a broad or comparative question within one ` +
    `subject — return exactly: []\n` +
    `2. When in doubt, return [].\n` +
    `3. If it blends distinct topics, return one sub-query PER TOPIC: at ` +
    `least 2, at most ${maxSubQueries}.\n` +
    `4. Each sub-query must cover exactly ONE topic. Never combine two ` +
    `topics in a sub-query, and never restate the whole query or the ` +
    `relationship between topics as a sub-query.\n` +
    `5. An enumeration of related groups or aspects within one topic (e.g. ` +
    `"migrants and youth" served by the same support) is ONE topic — never ` +
    `split it into per-group sub-queries.\n` +
    `6. Each sub-query must be self-contained (no pronouns or ` +
    `back-references) and reuse the original query's own wording. Do not ` +
    `introduce concepts the original does not mention.\n` +
    `7. Write the sub-queries in the same language as the original query.\n\n` +
    `Query: "${originalQuery}"`;

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Query decomposition timeout")),
      DECOMPOSITION_TIMEOUT_MS,
    );
  });

  let raw: string;
  try {
    ({ text: raw } = await Promise.race([
      generateAnswer({
        systemPrompt,
        userPrompt,
        // Sub-queries must be written in the query's language so they hit the
        // same lexical space as the corpus text they are meant to retrieve.
        language,
        maxOutputTokens: 120,
      }),
      timeout,
    ]));
  } catch {
    return [];
  } finally {
    clearTimeout(timer!);
  }

  try {
    const jsonMatch = raw.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]) as unknown[];
    const seen = new Set<string>();
    const valid: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "string") continue;
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;
      // Case is preserved (unlike multi-query's lowercasing): the service
      // normalizes queries itself, and the cross-encoder sees the text as-is.
      const key = trimmed.toLowerCase();
      if (key === originalQuery.trim().toLowerCase()) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      valid.push(trimmed);
    }
    if (valid.length < 2) return [];
    return valid.slice(0, maxSubQueries);
  } catch {
    return [];
  }
}

type MemoEntry = {
  expiresAt: number;
  value: string[];
};

/**
 * Memoize a decomposition function by (language, query). Decomposition of a
 * fixed query text is deterministic in intent, so repeat queries — production
 * re-asks and the benchmark's cached pass — skip the LLM round-trip that the
 * arm-1 A/B measured as ~1.2s of added cached-path p50 latency.
 */
export function memoizeDecomposition(
  fn: (query: string, language: SupportedLanguage) => Promise<string[]>,
  maxEntries = 500,
): (query: string, language: SupportedLanguage) => Promise<string[]> {
  const memo = new Map<string, MemoEntry>();

  return async (query, language) => {
    const key = `${language}::${query}`;
    const now = Date.now();
    const cached = memo.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const value = await fn(query, language);
    if (memo.size >= maxEntries) {
      // Maps iterate in insertion order; dropping the oldest entry keeps the
      // memo bounded without an LRU dependency.
      const oldest = memo.keys().next().value;
      if (oldest !== undefined) memo.delete(oldest);
    }
    memo.set(key, {
      value,
      expiresAt: now + env.RAG_CACHE_TTL_SECONDS * 1000,
    });
    return value;
  };
}

/** Process-wide memoized instance used by the router's default dependencies. */
export const decomposeQueryMemoized = memoizeDecomposition(decomposeQuery);
