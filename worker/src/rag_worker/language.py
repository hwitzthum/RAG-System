from collections import Counter

from rag_worker.types import SupportedLanguage


def normalize_language_hint(value: str | None) -> SupportedLanguage | None:
    if not value:
        return None
    normalized = value.strip().upper()
    if normalized in {"EN", "DE", "FR", "IT", "ES"}:
        return normalized  # type: ignore[return-value]
    return None


def detect_language(text: str, language_hint: SupportedLanguage | None = None) -> SupportedLanguage:
    if language_hint:
        return language_hint

    lowered = text.lower()
    if not lowered:
        return "EN"

    keyword_map: dict[SupportedLanguage, tuple[str, ...]] = {
        "DE": (" und ", " der ", " die ", " das ", " für "),
        "FR": (" le ", " la ", " les ", " des ", " pour "),
        "IT": (" il ", " lo ", " gli ", " per ", " con "),
        "ES": (" el ", " la ", " los ", " para ", " con "),
        "EN": (" the ", " and ", " for ", " with ", " from "),
    }

    scores = Counter()
    padded = f" {lowered} "
    for language, keywords in keyword_map.items():
        for keyword in keywords:
            scores[language] += padded.count(keyword)

    if not scores:
        return "EN"

    return max(scores.items(), key=lambda item: item[1])[0]
