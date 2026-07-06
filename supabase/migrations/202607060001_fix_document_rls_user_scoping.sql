-- Fix RLS on documents/document_chunks (and the private storage bucket) to
-- enforce per-user ownership.
--
-- documents.user_id was added in 202603140002_multi_provider_byok.sql, after
-- the original SELECT policies were created in
-- 202603060001_phase2_bootstrap.sql / 202603060002_phase3_core_schema.sql.
-- Those policies were never updated to reference it, so any authenticated
-- 'reader' could read/download any other user's "ready" document rows,
-- chunks, or original PDF directly via PostgREST/Storage — bypassing the
-- Next.js app's per-user access control entirely (app/api/query,
-- lib/ingestion/runtime/effective-documents.ts, etc. all scope by user_id,
-- but that logic is meaningless if the underlying tables don't).

DROP POLICY IF EXISTS documents_select_reader_admin ON public.documents;
CREATE POLICY documents_select_reader_admin
  ON public.documents
  FOR SELECT
  TO authenticated
  USING (
    public.is_reader_or_admin()
    AND (status = 'ready' OR public.is_admin())
    AND (user_id = auth.uid() OR user_id IS NULL OR public.is_admin())
  );

DROP POLICY IF EXISTS document_chunks_select_reader_admin ON public.document_chunks;
CREATE POLICY document_chunks_select_reader_admin
  ON public.document_chunks
  FOR SELECT
  TO authenticated
  USING (
    public.is_reader_or_admin()
    AND EXISTS (
      SELECT 1
      FROM public.documents d
      WHERE d.id = document_id
        AND (d.status = 'ready' OR public.is_admin())
        AND (d.user_id = auth.uid() OR d.user_id IS NULL OR public.is_admin())
    )
  );

DROP POLICY IF EXISTS documents_reader_select ON storage.objects;
CREATE POLICY documents_reader_select
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'documents'
    AND coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') IN ('reader', 'admin')
    AND EXISTS (
      SELECT 1
      FROM public.documents d
      WHERE d.storage_path = storage.objects.name
        AND (d.user_id = auth.uid() OR d.user_id IS NULL OR public.is_admin())
    )
  );
