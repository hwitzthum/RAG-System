import type { SupportedLanguage } from "@/lib/contracts/retrieval";

const LANGUAGE_KEYWORDS: Record<SupportedLanguage, readonly string[]> = {
  DE: [" und ", " der ", " die ", " das ", " für ", " mit "],
  FR: [" le ", " la ", " les ", " des ", " pour ", " avec "],
  IT: [" il ", " lo ", " gli ", " per ", " con ", " della "],
  ES: [" el ", " la ", " los ", " para ", " con ", " del "],
  EN: [" the ", " and ", " for ", " with ", " from ", " this "],
};

export function detectQueryLanguage(
  normalizedQuery: string,
  languageHint?: SupportedLanguage,
): SupportedLanguage {
  if (languageHint) {
    return languageHint;
  }

  if (!normalizedQuery) {
    return "EN";
  }

  const padded = ` ${normalizedQuery} `;
  let bestLanguage: SupportedLanguage = "EN";
  // Seeded at 0, not -1. With -1, a query that matched no keyword at all scored
  // 0 for every language and the first key in LANGUAGE_KEYWORDS (DE) won the
  // tie — so "how does artificial intelligence affect employee wellbeing"
  // resolved to DE and the model was instructed to answer in German. Starting
  // at 0 means a scoreless query keeps the documented EN default, and ties
  // resolve to EN rather than to whichever language happens to be declared
  // first.
  let bestScore = 0;

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
    }
  }

  return bestLanguage;
}
