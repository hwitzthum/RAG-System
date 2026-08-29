/**
 * Named works and organisations a question asserts the existence of.
 *
 * A question can be perfectly answerable in topic and still be built on a
 * false premise: "What were the main findings of the 2023 Global AI
 * Integration Report by the FutureTech Alliance?" names a report that does not
 * exist, about a subject the corpus genuinely covers. Retrieval returns real,
 * topically relevant chunks, the evidence gate sees nothing wrong with them,
 * and the answer attributes true findings to an invented source — the worst
 * shape a failure can take, because nothing in the output looks wrong.
 *
 * Relevance scoring cannot catch this. It measures whether evidence is *about*
 * the question; the missing fact is whether the thing the question names
 * *exists*. Measured on the benchmark's unanswerable slice, the false answers
 * scored top-3 means of 0.225–0.391 while the weakest genuine answer scored
 * 0.179 — the distributions overlap, and `calibrate-evidence-thresholds`
 * refuses to recommend a cut for exactly that reason.
 *
 * So the signal here is existence, checked by lexical probe against the
 * caller's own corpus. The same idea already runs offline: the evaluation
 * dataset generator verifies each unanswerable candidate by searching the
 * corpus for its probe term and discards the ones it finds.
 */

/**
 * Head nouns that mark the end of a named work or body. A capitalised phrase
 * ending in one of these is a citable thing — the kind of name a question can
 * be wrong about — rather than an ordinary noun phrase.
 */
const ENTITY_HEAD_NOUNS = new Set([
  // English
  "act",
  "agency",
  "alliance",
  "association",
  "board",
  "bureau",
  "charter",
  "committee",
  "conference",
  "consortium",
  "council",
  "foundation",
  "framework",
  "index",
  "initiative",
  "institute",
  "network",
  "programme",
  "program",
  "project",
  "report",
  "review",
  "society",
  "study",
  "summit",
  "survey",
  "symposium",
  // German
  "ausschuss",
  "bericht",
  "gesellschaft",
  "initiative",
  "institut",
  "konferenz",
  "programm",
  "projekt",
  "rat",
  "stiftung",
  "studie",
  "verband",
]);

/**
 * Words that may sit inside a name without being capitalised, so
 * "Future of Work Council" survives as one entity.
 */
const ENTITY_INFIX_WORDS = new Set([
  "of",
  "for",
  "and",
  "the",
  "on",
  "in",
  "de",
  "der",
  "die",
  "das",
  "und",
  "für",
  "von",
  "zur",
  "zum",
]);

const QUOTED_PATTERN = /["“”„«»']([^"“”„«»']{3,120})["“”„«»']/gu;

function isCapitalised(word: string): boolean {
  const first = word[0];
  return (
    first !== undefined && first === first.toUpperCase() && /\p{L}/u.test(first)
  );
}

function normalizeCandidate(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?]+$/u, "");
}

/**
 * Distinctive enough to be worth probing.
 *
 * Two capitalised words is the floor. One ("the Report") names nothing
 * specific, and gating on it would abstain on ordinary questions — the false
 * abstention rate has only ~2 points of headroom against its gate, so this
 * side of the trade has to stay conservative.
 */
function hasDistinctiveName(candidate: string): boolean {
  const capitalised = candidate
    .split(/\s+/)
    .filter((word) => /\p{L}/u.test(word) && isCapitalised(word));
  return capitalised.length >= 2;
}

/**
 * Capitalised runs that end in a head noun, scanned right-to-left from each
 * head so the longest name wins ("Global AI Integration Report", not
 * "Integration Report").
 */
function extractHeadNounEntities(question: string): string[] {
  const words = question.split(/\s+/).filter((word) => word.length > 0);
  const found: string[] = [];

  for (let index = 0; index < words.length; index += 1) {
    const bare = words[index]!.replace(/[^\p{L}\p{N}]/gu, "");
    if (!bare || !ENTITY_HEAD_NOUNS.has(bare.toLowerCase())) {
      continue;
    }
    if (!isCapitalised(bare)) {
      continue;
    }

    let start = index;
    while (start - 1 >= 0) {
      const previousBare = words[start - 1]!.replace(/[^\p{L}\p{N}]/gu, "");
      if (!previousBare) {
        break;
      }
      const lower = previousBare.toLowerCase();
      // An infix only continues a name if a capitalised word precedes it.
      if (ENTITY_INFIX_WORDS.has(lower)) {
        const beforeBare = words[start - 2]?.replace(/[^\p{L}\p{N}]/gu, "");
        if (beforeBare && isCapitalised(beforeBare)) {
          start -= 2;
          continue;
        }
        break;
      }
      if (isCapitalised(previousBare) || /^\d{4}$/.test(previousBare)) {
        start -= 1;
        continue;
      }
      break;
    }

    if (start === index) {
      continue;
    }
    found.push(normalizeCandidate(words.slice(start, index + 1).join(" ")));
  }

  return found;
}

/**
 * Named entities the question presupposes. Empty when it names nothing
 * specific, which is the common case and costs nothing.
 */
export function extractClaimedEntities(question: string): string[] {
  const candidates: string[] = [];

  for (const match of question.matchAll(QUOTED_PATTERN)) {
    const quoted = normalizeCandidate(match[1] ?? "");
    if (quoted) {
      candidates.push(quoted);
    }
  }

  candidates.push(...extractHeadNounEntities(question));

  const seen = new Set<string>();
  const entities: string[] = [];
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key) || !hasDistinctiveName(candidate)) {
      continue;
    }
    seen.add(key);
    entities.push(candidate);
  }

  return entities;
}

/**
 * The content words of an entity, for lexical probing. Leading years and
 * infixes are dropped: a corpus that discusses the body under a slightly
 * different year or connective still counts as supporting it, and the point is
 * to find names that appear nowhere at all.
 */
export function entityProbeTerms(entity: string): string[] {
  return entity
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(
      (word) =>
        word.length >= 3 &&
        !ENTITY_INFIX_WORDS.has(word.toLowerCase()) &&
        !/^\d{4}$/.test(word),
    );
}

export type UnsupportedPremise = {
  /** The name the question asserts exists but the corpus never mentions. */
  entity: string;
};

/**
 * The first named entity the question presupposes that appears nowhere in the
 * caller's corpus, or null when every name it uses is supported.
 *
 * Only a total absence counts. A name that appears even once is treated as
 * supported and the ordinary evidence gate decides from there — the false
 * abstention rate sits at 0.0313 against a 0.05 gate, so this must never be
 * the thing that starts refusing real questions.
 */
export async function findUnsupportedPremise(input: {
  question: string;
  /** Readable documents, or null for a caller who may read all of them. */
  documentIds: string[] | null;
  countMatches: (probe: {
    terms: string[];
    documentIds: string[] | null;
  }) => Promise<number>;
}): Promise<UnsupportedPremise | null> {
  const entities = extractClaimedEntities(input.question);
  if (entities.length === 0) {
    return null;
  }
  // An empty library supports nothing, but refusing on a premise there would
  // be misleading: the ordinary evidence gate already has nothing to work with
  // and gives the right answer for the right reason.
  if (input.documentIds !== null && input.documentIds.length === 0) {
    return null;
  }

  for (const entity of entities) {
    const terms = entityProbeTerms(entity);
    if (terms.length === 0) {
      continue;
    }
    const matches = await input.countMatches({
      terms,
      documentIds: input.documentIds,
    });
    if (matches === 0) {
      return { entity };
    }
  }

  return null;
}

/**
 * Refusal text for an unsupported premise.
 *
 * Deliberately not the generic insufficient-evidence message, which says the
 * evidence was too weak and invites the reader to rephrase. Here the evidence
 * was fine; the thing the question named does not exist in their library.
 * Saying which name is missing is what makes the answer actionable — and
 * stops the reader from assuming a retrieval failure and simply asking again.
 */
export function unsupportedPremiseMessage(entity: string): string {
  return `No document in your library mentions "${entity}". I have not answered, because doing so would attribute information to a source that is not in the indexed documents. If the name is spelled differently in your documents, try that spelling, or upload the source.`;
}
