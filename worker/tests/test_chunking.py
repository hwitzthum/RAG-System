import unittest

from rag_worker.chunking import chunk_sections, split_into_sections
from rag_worker.types import ExtractedPage


class ChunkingTests(unittest.TestCase):
    def test_split_into_sections_detects_heading(self) -> None:
        page = ExtractedPage(
            page_number=1,
            text="""OVERVIEW\nThis is an introduction paragraph.\n\nDETAILS\nSecond section content.""",
        )

        sections = split_into_sections(page)
        self.assertGreaterEqual(len(sections), 2)
        self.assertEqual(sections[0].section_title, "Overview")

    def test_chunk_sections_respects_overlap(self) -> None:
        repeated = " ".join(["token"] * 1800)
        sections = [
            type("S", (), {"page_number": 1, "section_title": "Overview", "text": repeated})(),
        ]

        chunks = chunk_sections(
            sections=sections,
            language="EN",
            target_tokens=700,
            overlap_tokens=120,
            min_chars=20,
        )

        self.assertGreaterEqual(len(chunks), 3)
        self.assertEqual(chunks[0].chunk_index, 0)


if __name__ == "__main__":
    unittest.main()
