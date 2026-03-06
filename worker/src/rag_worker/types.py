from dataclasses import dataclass
from typing import Literal

SupportedLanguage = Literal["EN", "DE", "FR", "IT", "ES"]
DocumentStatus = Literal["queued", "processing", "ready", "failed"]
IngestionJobStatus = Literal["queued", "processing", "completed", "failed", "dead_letter"]


@dataclass(slots=True)
class IngestionJob:
    id: str
    document_id: str
    status: IngestionJobStatus
    attempt: int


@dataclass(slots=True)
class DocumentRecord:
    id: str
    storage_path: str
    sha256: str
    title: str | None
    language: SupportedLanguage | None
    status: DocumentStatus
    ingestion_version: int


@dataclass(slots=True)
class ExtractedPage:
    page_number: int
    text: str


@dataclass(slots=True)
class Section:
    page_number: int
    section_title: str
    text: str


@dataclass(slots=True)
class ChunkCandidate:
    chunk_index: int
    page_number: int
    section_title: str
    content: str
    language: SupportedLanguage


@dataclass(slots=True)
class ChunkWithContext:
    chunk_index: int
    page_number: int
    section_title: str
    content: str
    context: str
    language: SupportedLanguage


@dataclass(slots=True)
class PreparedChunkRecord:
    document_id: str
    chunk_index: int
    page_number: int
    section_title: str
    content: str
    context: str
    language: SupportedLanguage
    embedding: list[float]
