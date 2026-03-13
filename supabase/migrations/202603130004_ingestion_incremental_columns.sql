-- Add incremental processing columns to ingestion_jobs.
-- chunk_candidates stores the extracted chunks as JSONB so subsequent
-- invocations can resume without re-extracting the PDF.
-- chunks_total / chunks_processed track progress across invocations.

ALTER TABLE ingestion_jobs ADD COLUMN IF NOT EXISTS chunk_candidates JSONB;
ALTER TABLE ingestion_jobs ADD COLUMN IF NOT EXISTS chunks_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingestion_jobs ADD COLUMN IF NOT EXISTS chunks_processed INTEGER NOT NULL DEFAULT 0;
