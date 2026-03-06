import type { RetrievedChunk } from "@/lib/contracts/retrieval";
import { extractQueryTokens } from "@/lib/retrieval/query";

type RerankInput = {
  normalizedQuery: string;
  candidates: RetrievedChunk[];
  poolSize: number;
  topK: number;
};

function scoreLexicalOverlap(tokens: string[], searchableText: string): number {
  if (tokens.length === 0) {
    return 0;
  }

  let matches = 0;
  for (const token of tokens) {
    if (searchableText.includes(token)) {
      matches += 1;
    }
  }

  return matches / tokens.length;
}

export function rerankCandidates(input: RerankInput): RetrievedChunk[] {
  const poolSize = Math.max(1, input.poolSize);
  const topK = Math.max(1, input.topK);
  const tokens = extractQueryTokens(input.normalizedQuery);

  const pool = input.candidates.slice(0, poolSize).map((candidate) => {
    const searchableText = `${candidate.sectionTitle} ${candidate.context} ${candidate.content}`.toLowerCase();
    const lexical = scoreLexicalOverlap(tokens, searchableText);
    const exactMatch = searchableText.includes(input.normalizedQuery) ? 1 : 0;

    const rerankScore = candidate.retrievalScore * 0.6 + lexical * 0.35 + exactMatch * 0.05;
    return { ...candidate, rerankScore };
  });

  pool.sort((left, right) => {
    const rerankDiff = (right.rerankScore ?? 0) - (left.rerankScore ?? 0);
    if (rerankDiff !== 0) {
      return rerankDiff;
    }
    return right.retrievalScore - left.retrievalScore;
  });

  return pool.slice(0, topK);
}
