import type {
  RetrievedChunk,
  SupportedLanguage,
} from "@/lib/contracts/retrieval";
import { extractQueryTokens } from "@/lib/retrieval/query";

type RerankInput = {
  normalizedQuery: string;
  candidates: RetrievedChunk[];
  poolSize: number;
  topK: number;
  language?: SupportedLanguage;
};

// Weights for the ordering score. `retrievalScore` here is the RRF score,
// normalised against the best candidate in the pool, so this blend is
// pool-relative by construction.
const ORDER_RETRIEVAL_WEIGHT = 0.55;
const ORDER_LEXICAL_WEIGHT = 0.3;
const ORDER_VECTOR_WEIGHT = 0.1;
const ORDER_EXACT_MATCH_WEIGHT = 0.05;

// Weights for the absolute relevance score. Deliberately built from
// `vectorScore` (cosine similarity, an absolute measure) and lexical overlap
// rather than from RRF, which says nothing about how good the pool's best
// candidate actually is.
const RELEVANCE_VECTOR_WEIGHT = 0.65;
const RELEVANCE_LEXICAL_WEIGHT = 0.3;
const RELEVANCE_EXACT_MATCH_WEIGHT = 0.05;

// Applied to the ordering score only. Small on purpose: now that there is no
// hard language filter, this is a tie-breaker between otherwise comparable
// chunks, not a gate. It must not be able to float an irrelevant same-language
// chunk above a relevant cross-language one.
const LANGUAGE_MATCH_BOOST = 0.04;

// A keyword-only candidate has no cosine similarity to draw on. Treating it as
// vector-similarity 0 would make it structurally incapable of clearing the
// evidence gate, so its lexical overlap stands in for the vector term. This is
// a stand-in rather than a claim of equivalence, hence the discount.
const KEYWORD_ONLY_VECTOR_PROXY_DISCOUNT = 0.6;

// Query tokens at or above this length may match a chunk token by prefix, so
// that an inflected or compounded form still counts ("unterstützungsantrag"
// matching "unterstützungsanträge"). Below it, only whole-token equality
// counts.
const PREFIX_MATCH_MIN_LENGTH = 5;

const WORD_SPLIT_PATTERN = /[^\p{L}\p{N}]+/u;

function tokenizeSearchableText(searchableText: string): Set<string> {
  return new Set(
    searchableText.split(WORD_SPLIT_PATTERN).filter((part) => part.length > 0),
  );
}

/**
 * Fraction of query tokens present in the chunk, matched on word boundaries.
 *
 * This previously used `searchableText.includes(token)`, i.e. a substring test.
 * Short tokens matched inside unrelated words — a French query's "la" and "de"
 * matched *Lage* and *der* in German text, scoring an entirely off-topic query
 * at 2/7 overlap. Since this feeds the absolute relevance score, that noise
 * went straight into the evidence gate.
 */
function scoreLexicalOverlap(
  tokens: string[],
  chunkTokens: Set<string>,
): number {
  if (tokens.length === 0) {
    return 0;
  }

  let matches = 0;
  for (const token of tokens) {
    if (chunkTokens.has(token)) {
      matches += 1;
      continue;
    }

    if (token.length >= PREFIX_MATCH_MIN_LENGTH) {
      for (const chunkToken of chunkTokens) {
        if (chunkToken.startsWith(token) || token.startsWith(chunkToken)) {
          matches += 1;
          break;
        }
      }
    }
  }

  return matches / tokens.length;
}

function clampUnitInterval(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Heuristic reranker used when no cross-encoder is configured.
 *
 * Emits two distinct scores, because one field previously had to serve two
 * incompatible purposes:
 *
 *  - `rerankScore` orders the pool. It normalises `retrievalScore` against the
 *    pool maximum, so the best candidate always lands near the top of the range.
 *  - `relevanceScore` answers "is this actually relevant?" in absolute terms.
 *
 * Reading the ordering score as though it were absolute is why the
 * insufficient-evidence gate never fired: the top candidate of any pool,
 * however weak, scored above `RAG_MIN_RERANK_SCORE`.
 */
export function rerankCandidates(input: RerankInput): RetrievedChunk[] {
  const poolSize = Math.max(1, input.poolSize);
  const topK = Math.max(1, input.topK);
  const tokens = extractQueryTokens(input.normalizedQuery);

  const pool = input.candidates.slice(0, poolSize);

  // Normalize retrieval scores to [0, 1] so they are on the same scale as lexical (0-1).
  // RRF scores are small (~0.03 max) and would be dominated by the lexical component otherwise.
  const maxRetrieval = pool.reduce(
    (max, c) => Math.max(max, c.retrievalScore),
    0,
  );

  const scored = pool.map((candidate) => {
    const searchableText =
      `${candidate.sectionTitle} ${candidate.context} ${candidate.content}`.toLowerCase();
    const lexical = scoreLexicalOverlap(
      tokens,
      tokenizeSearchableText(searchableText),
    );
    const exactMatch = searchableText.includes(input.normalizedQuery) ? 1 : 0;
    const languageBoost =
      input.language && candidate.language === input.language
        ? LANGUAGE_MATCH_BOOST
        : 0;

    // Normalize retrieval score relative to the best candidate (divide by max).
    // This preserves relative ordering while mapping scores to [0, 1].
    const normalizedRetrieval =
      maxRetrieval > 0 ? candidate.retrievalScore / maxRetrieval : 1;

    // Absolute cosine similarity, present only on vector-sourced candidates.
    const absoluteVector =
      candidate.vectorScore ?? lexical * KEYWORD_ONLY_VECTOR_PROXY_DISCOUNT;

    const rerankScore = clampUnitInterval(
      normalizedRetrieval * ORDER_RETRIEVAL_WEIGHT +
        lexical * ORDER_LEXICAL_WEIGHT +
        absoluteVector * ORDER_VECTOR_WEIGHT +
        exactMatch * ORDER_EXACT_MATCH_WEIGHT +
        languageBoost,
    );

    const relevanceScore = clampUnitInterval(
      absoluteVector * RELEVANCE_VECTOR_WEIGHT +
        lexical * RELEVANCE_LEXICAL_WEIGHT +
        exactMatch * RELEVANCE_EXACT_MATCH_WEIGHT,
    );

    return {
      ...candidate,
      rerankScore,
      relevanceScore,
      scoreScale: "heuristic" as const,
    };
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
