import type { SupportedLanguage } from "@/lib/contracts/retrieval";

// " fuer " covers PDFs whose umlauts did not survive extraction, which is why
// the ingestion pipeline carried its own copy of this table. The two copies
// then drifted, and the same tie-break defect had to be fixed twice — hence a
// single shared table.
// Keywords shared by more than one language are listed under every language
// they belong to, so the shared word contributes to both scores and the
// distinguishing words decide the outcome. Listing " des " under French alone
// scored an unmistakably German chunk ("... des/der Antragsteller*in beim
// Migrationsamt des Kantons Zürich") as confidently French, because German's
// own articles happened not to appear with surrounding spaces. " la " and
// " con " were already shared this way.
const LANGUAGE_KEYWORDS: Record<SupportedLanguage, readonly string[]> = {
  // The German article-only list missed any question phrased without one
  // ("Wie repariere ich einen platten Fahrradreifen?" scored zero). That used
  // to resolve to DE anyway, but only because DE was declared first and won the
  // scoreless tie — the same accident that had English questions answered in
  // German. The pronouns and verbs below carry no overlap with the other four
  // supported languages, so they add German coverage without creating ties.
  DE: [
    " und ",
    " der ",
    " die ",
    " das ",
    " des ",
    " für ",
    " fuer ",
    " mit ",
    " ich ",
    " ist ",
    " ein ",
    " eine ",
    " einen ",
    " nicht ",
    " von ",
    " sich ",
    " auf ",
  ],
  FR: [" le ", " la ", " les ", " des ", " pour ", " avec "],
  IT: [" il ", " lo ", " gli ", " per ", " con ", " della "],
  ES: [" el ", " la ", " los ", " para ", " con ", " del "],
  EN: [" the ", " and ", " for ", " with ", " from ", " this "],
};

export type LanguageDetection = {
  language: SupportedLanguage;
  /**
   * False when the text produced no keyword evidence, or when the leading
   * candidate was tied with another language. Callers must supply their own
   * fallback rather than trusting `language` in that case.
   */
  confident: boolean;
  score: number;
};

/**
 * Keyword-frequency language detection with an explicit confidence signal.
 *
 * The confidence flag exists because this heuristic fails in two ways that are
 * indistinguishable from success if you only look at the returned language:
 *
 *  - No evidence at all. A short fragment such as "COORDINATION & CAPACITY"
 *    matches nothing, every language scores 0, and whichever language is
 *    declared first wins. That silently labelled English chunks as German.
 *  - Ambiguous evidence. Several keywords are shared across languages (" des "
 *    is German and French, " la " is French and Spanish, " con " is Italian and
 *    Spanish), so a tie is a genuine "don't know", not a result.
 *
 * Callers decide what to do without evidence: queries fall back to EN, while
 * ingestion falls back to the language of the surrounding document, which is a
 * far better prior for a short fragment than a six-keyword guess.
 */
// Damaged PDF extraction does not merely make detection uncertain — it makes it
// confidently wrong, because the damage manufactures keyword matches. Both
// shapes below were observed in this corpus mislabelling German chunks as
// Spanish, Italian or French, so such text is refused outright rather than
// scored.
const SPACED_TEXT_MIN_TOKENS = 8;
const SPACED_TEXT_SINGLE_CHAR_RATIO = 0.3;
const MOJIBAKE_MIN_LENGTH = 24;
const MOJIBAKE_SYMBOL_RATIO = 0.12;

// Anything outside letters, digits, spaces and ordinary punctuation. Accented
// letters are \p{L} and stay welcome, so German and French prose is unaffected.
const UNEXPECTED_CHARACTER_PATTERN =
  /[^\p{L}\p{N}\p{Zs}.,;:!?()"'%/&+\-–—§@#*[\]€$]/gu;

/**
 * Character-spaced extraction: "r t er t ot a l Ð 3 Ab stz e". The stray single
 * characters form accidental keyword hits (" el ", " la ", " con "). The token
 * floor keeps short human-typed queries, where one-letter words are normal, out
 * of scope.
 */
function isCharacterSpacedText(text: string): boolean {
  const tokens = text.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length < SPACED_TEXT_MIN_TOKENS) {
    return false;
  }

  const singleCharTokens = tokens.filter((token) => token.length === 1).length;
  return singleCharTokens / tokens.length > SPACED_TEXT_SINGLE_CHAR_RATIO;
}

/** Mis-decoded bytes: "©qh ýü#8Ì¸òÇg Xº 3½ ®Ä~ê¹ó7¬5ëWúuÄ=fòú". */
function isMojibake(text: string): boolean {
  if (text.length < MOJIBAKE_MIN_LENGTH) {
    return false;
  }

  const unexpected = text.match(UNEXPECTED_CHARACTER_PATTERN)?.length ?? 0;
  return unexpected / text.length > MOJIBAKE_SYMBOL_RATIO;
}

export function detectLanguageWithConfidence(text: string): LanguageDetection {
  if (!text) {
    return { language: "EN", confident: false, score: 0 };
  }

  if (isCharacterSpacedText(text) || isMojibake(text)) {
    return { language: "EN", confident: false, score: 0 };
  }

  const padded = ` ${text.toLowerCase()} `;
  let bestLanguage: SupportedLanguage = "EN";
  let bestScore = 0;
  let tied = false;

  for (const [language, keywords] of Object.entries(LANGUAGE_KEYWORDS) as [
    SupportedLanguage,
    readonly string[],
  ][]) {
    let score = 0;
    for (const keyword of keywords) {
      score += padded.split(keyword).length - 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestLanguage = language;
      tied = false;
    } else if (score === bestScore && score > 0) {
      tied = true;
    }
  }

  return {
    language: bestLanguage,
    confident: bestScore > 0 && !tied,
    score: bestScore,
  };
}

export function detectQueryLanguage(
  normalizedQuery: string,
  languageHint?: SupportedLanguage,
): SupportedLanguage {
  if (languageHint) {
    return languageHint;
  }

  const detection = detectLanguageWithConfidence(normalizedQuery);

  // A query has no surrounding document to inherit from, so the two failure
  // modes are treated differently here:
  //
  //  - No evidence at all (score 0): fall back to EN, the documented default.
  //    This is the case that used to resolve to DE by declaration order and had
  //    English questions answered in German.
  //  - Ambiguous evidence (score > 0, tied): keep the leading candidate. The
  //    tie usually comes from a keyword two languages share (" la " is both
  //    French and Spanish), so answering a French question in French beats
  //    discarding the evidence and answering in English.
  //
  // Ingestion takes the opposite branch for ambiguity, inheriting the
  // document's language, because there a better prior is available.
  if (detection.score > 0) {
    return detection.language;
  }

  return "EN";
}
