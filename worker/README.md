# Worker Service

Production ingestion worker for Phase 6 pipeline:

- extraction (with OCR fallback path)
- section-aware chunking (700 target / 120 overlap)
- contextual summary generation
- embedding generation
- chunk upsert into `document_chunks`
- retry/dead-letter handling on `ingestion_jobs`
- stale lock recovery for stuck `processing` jobs

## Quick Start

```bash
cd worker
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
cp .env.example .env
python -m rag_worker.main --once
```

## Runtime Modes

```bash
# one job
python -m rag_worker.main --once

# bounded batch
python -m rag_worker.main --max-jobs 25

# continuous poller
python -m rag_worker.main
```

## Notes

- If `OPENAI_API_KEY` is not set, embeddings fall back to deterministic local vectors for development.
- OCR fallback attempts optional local OCR backends (`pdf2image` + `pytesseract`) when available.
- Stale lock reclaim window is controlled by `WORKER_LOCK_TIMEOUT_SECONDS`.

## Test Commands

```bash
python3 -m py_compile src/rag_worker/*.py tests/test_*.py
PYTHONPATH=src python3 -m unittest discover -s tests -p 'test_*.py'
```
