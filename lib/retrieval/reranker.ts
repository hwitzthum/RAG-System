import type { RetrievedChunk } from "@/lib/contracts/retrieval";
import { extractQueryTokens } from "@/lib/retrieval/query";

type RerankInput = {
  normalizedQuery: string;
  candidates: RetrievedChunk[];
  poolSize: number;
  topK: number;
};

const RETRIEVAL_WEIGHT = 0.6;
const LEXICAL_WEIGHT = 0.35;
const EXACT_MATCH_WEIGHT = 0.05;

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

  const pool = input.candidates.slice(0, poolSize);

  // Normalize retrieval scores to [0, 1] so they are on the same scale as lexical (0-1).
  // RRF scores are small (~0.03 max) and would be dominated by the lexical component otherwise.
  const maxRetrieval = pool.reduce((max, c) => Math.max(max, c.retrievalScore), 0);

  const scored = pool.map((candidate) => {
    const searchableText = `${candidate.sectionTitle} ${candidate.context} ${candidate.content}`.toLowerCase();
    const lexical = scoreLexicalOverlap(tokens, searchableText);
    const exactMatch = searchableText.includes(input.normalizedQuery) ? 1 : 0;

    // Normalize retrieval score relative to the best candidate (divide by max).
    // This preserves relative ordering while mapping scores to [0, 1].
    const normalizedRetrieval = maxRetrieval > 0
      ? candidate.retrievalScore / maxRetrieval
      : 1;

    const rerankScore = normalizedRetrieval * RETRIEVAL_WEIGHT + lexical * LEXICAL_WEIGHT + exactMatch * EXACT_MATCH_WEIGHT;
    return { ...candidate, rerankScore };
  });

  scored.sort((left, right) => {
    const rerankDiff = (right.rerankScore ?? 0) - (left.rerankScore ?? 0);
    if (rerankDiff !== 0) {
      return rerankDiff;
    }
    return right.retrievalScore - left.retrievalScore;
  });

  return scored.slice(0, topK);
}
