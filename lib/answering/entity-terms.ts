import type {
  RetrievedChunk,
  SupportedLanguage,
} from "@/lib/contracts/retrieval";

export type EntityTermCheck = {
  terms: string[];
  missingTerms: string[];
};

// Deliberately tiny: these only have to stop function words from being
// mistaken for entity names, not model either language.
const EN_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "if",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "by",
  "with",
  "about",
  "from",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "does",
  "do",
  "did",
  "has",
  "have",
  "had",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "when",
  "where",
  "why",
  "how",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "there",
  "their",
  "they",
  "not",
  "no",
]);

const DE_STOPWORDS = new Set([
  "der",
  "die",
  "das",
  "den",
  "dem",
  "des",
  "ein",
  "eine",
  "einen",
  "einem",
  "einer",
  "eines",
  "und",
  "oder",
  "aber",
  "wenn",
  "von",
  "vom",
  "im",
  "in",
  "an",
  "am",
  "auf",
  "zu",
  "zur",
  "zum",
  "für",
  "mit",
  "über",
  "aus",
  "als",
  "ist",
  "sind",
  "war",
  "waren",
  "wird",
  "werden",
  "wurde",
  "wurden",
  "hat",
  "haben",
  "hatte",
  "was",
  "welche",
  "welcher",
  "welches",
  "wer",
  "wann",
  "wo",
  "warum",
  "wie",
  "es",
  "sie",
  "er",
  "dies",
  "diese",
  "dieser",
  "dieses",
  "nicht",
  "kein",
  "keine",
]);

// Opening quote captured with its matching closer so an apostrophe inside a
// word never opens a phrase. „…" may close with either a high curly quote or
// a straight one, depending on the input method.
const QUOTED_PHRASE_PATTERNS = [
  /"([^"]+)"/g,
  /'([^']+)'/g,
  /„([^“”"]+)[“”"]/g, // „…“
  /“([^”]+)”/g, // “…”
  /«([^»]+)»/g,
];

const WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/** Minimum shared-prefix length for the inflection match below. */
const PREFIX_MATCH_LENGTH = 5;

function stopwordsFor(language: SupportedLanguage): Set<string> {
  return language === "DE" ? DE_STOPWORDS : EN_STOPWORDS;
}

function isCapitalized(word: string): boolean {
  const first = word.charAt(0);
  return /\p{Lu}/u.test(first);
}

/**
 * Deterministic, LLM-free extraction of the terms a query is *about*:
 * quoted phrases plus capitalized runs. Sentence-initial runs are excluded —
 * every sentence starts capitalized — and in German a SINGLE capitalized
 * mid-sentence word is excluded too, because every German noun is
 * capitalized; only a run of two or more words is an entity signal there.
 * In English a single mid-sentence capitalized word may count.
 */
export function extractQueryEntityTerms(
  query: string,
  language: SupportedLanguage,
): string[] {
  const stopwords = stopwordsFor(language);
  const terms: string[] = [];
  const seen = new Set<string>();

  const addTerm = (term: string) => {
    const trimmed = term.trim();
    if (!trimmed) {
      return;
    }
    const tokens = trimmed.match(WORD_PATTERN) ?? [];
    // A term made of nothing but stopwords is not an entity.
    if (tokens.every((token) => stopwords.has(token.toLowerCase()))) {
      return;
    }
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      terms.push(trimmed);
    }
  };

  for (const pattern of QUOTED_PHRASE_PATTERNS) {
    for (const match of query.matchAll(pattern)) {
      addTerm(match[1]!);
    }
  }

  for (const sentence of query.split(/(?<=[.!?])\s+/)) {
    const words = sentence.match(WORD_PATTERN) ?? [];
    let run: string[] = [];
    let runStartIndex = -1;

    const flushRun = () => {
      if (runStartIndex === 0) {
        // Sentence-initial run: capitalization proves nothing there.
      } else if (run.length >= 2) {
        addTerm(run.join(" "));
      } else if (run.length === 1 && language !== "DE") {
        addTerm(run[0]!);
      }
      run = [];
      runStartIndex = -1;
    };

    words.forEach((word, index) => {
      if (isCapitalized(word) && !stopwords.has(word.toLowerCase())) {
        if (run.length === 0) {
          runStartIndex = index;
        }
        run.push(word);
      } else {
        flushRun();
      }
    });
    flushRun();
  }

  return terms;
}

/**
 * Is every extracted query term visible somewhere in the evidence? A term is
 * grounded when it appears as a case-insensitive substring (which also covers
 * German compounds — "Wirkungsindikatoren" is found inside
 * "Wirkungsindikatorenrahmen"), or when every token of ≥5 characters shares
 * a ≥5-character prefix with some evidence word (inflected forms). Purely a
 * signal for the CRAG prompt guard; no retrieval or answering behavior lives
 * here.
 */
export function checkEntityGrounding(input: {
  query: string;
  language: SupportedLanguage;
  chunks: RetrievedChunk[];
}): EntityTermCheck {
  const terms = extractQueryEntityTerms(input.query, input.language);
  if (terms.length === 0) {
    return { terms, missingTerms: [] };
  }

  const haystack = input.chunks
    .map((chunk) => `${chunk.content}\n${chunk.context}`)
    .join("\n")
    .toLowerCase();
  const evidenceWords = new Set(haystack.match(WORD_PATTERN) ?? []);

  const prefixMatches = (token: string): boolean => {
    for (const word of evidenceWords) {
      let shared = 0;
      const limit = Math.min(token.length, word.length);
      while (shared < limit && token[shared] === word[shared]) {
        shared += 1;
      }
      if (shared >= PREFIX_MATCH_LENGTH) {
        return true;
      }
    }
    return false;
  };

  const isGrounded = (term: string): boolean => {
    const lowered = term.toLowerCase();
    if (haystack.includes(lowered)) {
      return true;
    }
    const tokens = (lowered.match(WORD_PATTERN) ?? []).filter(
      (token) => token.length >= PREFIX_MATCH_LENGTH,
    );
    return tokens.length > 0 && tokens.every(prefixMatches);
  };

  return {
    terms,
    missingTerms: terms.filter((term) => !isGrounded(term)),
  };
}
