-- Fix: document_effective_statuses view was implicitly SECURITY DEFINER
-- because it is owned by the postgres superuser (bypassrls = true).
-- Setting security_invoker = on ensures the view runs with the caller's
-- permissions so RLS policies on the underlying tables are enforced.
--
-- Impact:
--   - Admins: no change (admin policy covers documents + ingestion_jobs + document_chunks)
--   - Readers: now correctly see only ready documents; job columns return NULL
--     because there is no reader policy on ingestion_jobs (effective_status
--     falls to ELSE d.status = 'ready', which is correct)
--   - Service role (ingestion scripts): bypassrls regardless — no change

ALTER VIEW public.document_effective_statuses SET (security_invoker = on);