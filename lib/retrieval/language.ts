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
  let bestScore = -1;

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
