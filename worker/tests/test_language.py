import unittest

from rag_worker.language import detect_language, normalize_language_hint


class LanguageTests(unittest.TestCase):
    def test_normalize_language_hint(self) -> None:
        self.assertEqual(normalize_language_hint("de"), "DE")
        self.assertEqual(normalize_language_hint(" ES "), "ES")
        self.assertIsNone(normalize_language_hint("pt"))

    def test_detect_language_prefers_hint(self) -> None:
        text = "This text includes English words."
        self.assertEqual(detect_language(text, "FR"), "FR")

    def test_detect_language_heuristics(self) -> None:
        text = "Der Kunde und die Produkte sind fuer die Region.".replace("fuer", "für")
        self.assertEqual(detect_language(text, None), "DE")


if __name__ == "__main__":
    unittest.main()
