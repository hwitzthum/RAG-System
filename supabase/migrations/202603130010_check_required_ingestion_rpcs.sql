CREATE OR REPLACE FUNCTION public.check_required_ingestion_rpcs(required_functions text[] DEFAULT NULL)
RETURNS TABLE (
  function_name text,
  is_present boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH requested_functions AS (
    SELECT unnest(
      COALESCE(
        required_functions,
        ARRAY[
          'claim_ingestion_jobs',
          'complete_ingestion_job',
          'fail_ingestion_job',
          'create_document_with_ingestion_job',
          'requeue_dead_letter_document',
          'reconcile_document_status',
          'reconcile_ingestion_job_state'
        ]::text[]
      )
    ) AS function_name
  )
  SELECT
    rf.function_name,
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = rf.function_name
    ) AS is_present
  FROM requested_functions rf;
$$;

REVOKE ALL ON FUNCTION public.check_required_ingestion_rpcs(text[]) FROM public;
GRANT EXECUTE ON FUNCTION public.check_required_ingestion_rpcs(text[]) TO service_role;
