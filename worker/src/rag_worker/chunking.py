import re
from dataclasses import dataclass

from rag_worker.types import ChunkCandidate, ExtractedPage, Section, SupportedLanguage

_HEADING_RE = re.compile(r"^(?:\d+(?:\.\d+)*\s+)?[A-ZÄÖÜ0-9][A-ZÄÖÜ0-9\s:/-]{3,}$")

try:
    import tiktoken
except Exception:  # pragma: no cover - fallback path for missing optional tokenizer runtime
    tiktoken = None  # type: ignore[assignment]


@dataclass(slots=True)
class TokenCodec:
    use_tiktoken: bool

    @classmethod
    def create(cls) -> "TokenCodec":
        return cls(use_tiktoken=tiktoken is not None)

    def encode(self, text: str) -> list[int]:
        if self.use_tiktoken and tiktoken is not None:
            encoder = tiktoken.get_encoding("cl100k_base")
            return encoder.encode(text)
        # fallback pseudo-tokenization by word index
        words = text.split()
        return list(range(len(words)))

    def decode(self, text: str, token_start: int, token_end: int) -> str:
        if self.use_tiktoken and tiktoken is not None:
            encoder = tiktoken.get_encoding("cl100k_base")
            tokens = encoder.encode(text)
            return encoder.decode(tokens[token_start:token_end])

        words = text.split()
        return " ".join(words[token_start:token_end])


def _is_heading(line: str) -> bool:
    candidate = line.strip()
    if not candidate:
        return False
    if len(candidate) > 120:
        return False
    return _HEADING_RE.match(candidate) is not None


def split_into_sections(page: ExtractedPage) -> list[Section]:
    lines = [line.strip() for line in page.text.splitlines()]
    sections: list[Section] = []

    current_title = f"Page {page.page_number}"
    current_content: list[str] = []

    for line in lines:
        if not line:
            continue

        if _is_heading(line):
            if current_content:
                sections.append(
                    Section(
                        page_number=page.page_number,
                        section_title=current_title,
                        text="\n".join(current_content).strip(),
                    )
                )
                current_content = []
            current_title = line.title()
            continue

        current_content.append(line)

    if current_content:
        sections.append(
            Section(
                page_number=page.page_number,
                section_title=current_title,
                text="\n".join(current_content).strip(),
            )
        )

    if not sections and page.text.strip():
        sections.append(
            Section(
                page_number=page.page_number,
                section_title=f"Page {page.page_number}",
                text=page.text.strip(),
            )
        )

    return sections


def chunk_sections(
    sections: list[Section],
    language: SupportedLanguage,
    target_tokens: int,
    overlap_tokens: int,
    min_chars: int,
) -> list[ChunkCandidate]:
    if target_tokens <= 0:
        raise ValueError("target_tokens must be positive")
    if overlap_tokens < 0:
        raise ValueError("overlap_tokens cannot be negative")
    if overlap_tokens >= target_tokens:
        raise ValueError("overlap_tokens must be smaller than target_tokens")

    codec = TokenCodec.create()
    chunks: list[ChunkCandidate] = []
    chunk_index = 0

    for section in sections:
        if not section.text:
            continue

        total_tokens = len(codec.encode(section.text))
        start = 0

        while start < total_tokens:
            end = min(start + target_tokens, total_tokens)
            content = codec.decode(section.text, start, end).strip()

            if len(content) >= min_chars:
                chunks.append(
                    ChunkCandidate(
                        chunk_index=chunk_index,
                        page_number=section.page_number,
                        section_title=section.section_title,
                        content=content,
                        language=language,
                    )
                )
                chunk_index += 1

            if end >= total_tokens:
                break

            start = max(end - overlap_tokens, start + 1)

    return chunks
