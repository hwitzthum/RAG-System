const TOKEN_SPLIT_PATTERN = /[^\p{L}\p{N}]+/u;

export function normalizeQuery(rawQuery: string): string {
  return rawQuery.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function extractQueryTokens(normalizedQuery: string): string[] {
  if (!normalizedQuery) {
    return [];
  }

  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const token of normalizedQuery.split(TOKEN_SPLIT_PATTERN)) {
    const trimmed = token.trim();
    if (trimmed.length < 2 || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    tokens.push(trimmed);

    if (tokens.length >= 32) {
      break;
    }
  }

  return tokens;
}
