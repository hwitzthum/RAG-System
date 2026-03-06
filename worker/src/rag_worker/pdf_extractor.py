from io import BytesIO
from logging import Logger

from pypdf import PdfReader

from rag_worker.types import ExtractedPage


def _try_ocr_fallback(pdf_bytes: bytes, page_number: int, logger: Logger) -> str:
    """Optional OCR fallback for scanned pages.

    This path only runs when optional runtime packages are available.
    If unavailable, extraction continues with an empty page text.
    """

    try:
        from pdf2image import convert_from_bytes  # type: ignore
        import pytesseract  # type: ignore
    except Exception:
        logger.warning("ocr_fallback_backend_unavailable", extra={"page_number": page_number})
        return ""

    try:
        images = convert_from_bytes(pdf_bytes, first_page=page_number, last_page=page_number, dpi=200)
        if not images:
            return ""
        return (pytesseract.image_to_string(images[0]) or "").strip()
    except Exception as exc:  # pragma: no cover - OCR backend failure path
        logger.warning("ocr_fallback_failed", extra={"page_number": page_number, "error": str(exc)})
        return ""


def extract_pages(pdf_bytes: bytes, enable_ocr_fallback: bool, logger: Logger) -> list[ExtractedPage]:
    reader = PdfReader(BytesIO(pdf_bytes))
    pages: list[ExtractedPage] = []

    for page_number, page in enumerate(reader.pages, start=1):
        extracted = (page.extract_text() or "").strip()

        if not extracted and enable_ocr_fallback:
            extracted = _try_ocr_fallback(pdf_bytes, page_number, logger)

        pages.append(ExtractedPage(page_number=page_number, text=extracted))

    return pages
