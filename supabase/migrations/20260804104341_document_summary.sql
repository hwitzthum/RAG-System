-- Document-level summary for full contextual retrieval: generated once per
-- document at ingest and fed into every chunk's context-generation prompt so
-- chunk contexts situate the chunk within the whole document. Additive and
-- nullable; existing documents gain a summary on their next (re-)ingest.

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS summary text;

COMMENT ON COLUMN public.documents.summary IS
  'One-paragraph LLM summary generated at ingest; used to contextualise chunk embeddings. NULL until the document is (re-)ingested.';
