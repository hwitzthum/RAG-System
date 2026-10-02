-- Restrict service-only SECURITY DEFINER RPCs to service_role.
--
-- Why: these functions were created with
--     REVOKE ALL ON FUNCTION ... FROM public;
--     GRANT EXECUTE ON FUNCTION ... TO service_role;
-- but Supabase default privileges also grant EXECUTE directly to `anon` and
-- `authenticated`, and REVOKE ... FROM public does not remove those direct
-- grants (see 202603060006_phase12_ingestion_job_rpc_acl_fix.sql, which fixed
-- only three functions). The bodies contain no role check, so anyone holding
-- the public anon key could call them through PostgREST
-- (POST /rest/v1/rpc/<name>), e.g. delete_document_cascade or
-- replace_document_chunks against another user's document.
--
-- Every caller in this repo reaches these functions through
-- getSupabaseAdminClient() (service_role), so removing anon/authenticated is
-- behaviour-preserving for the app.
--
-- Deliberately NOT touched: public.is_admin(), public.app_role(),
-- public.is_reader_or_admin() (evaluated inside RLS policies as the calling
-- role) and the SECURITY INVOKER search RPCs (match_document_chunks,
-- search_document_chunks_keyword).
--
-- Idempotent; resolves every overload by name and skips names that do not
-- exist, so it is safe on a fresh rebuild and on the live database.

do $$
declare
  fn record;
  fn_names constant text[] := array[
    'append_document_chunks',
    'check_required_ingestion_rpcs',
    'checkpoint_ingestion_job',
    'claim_ingestion_jobs',
    'complete_ingestion_job',
    'consume_rate_limit',
    'create_document_with_ingestion_job',
    'create_document_with_ingestion_job_for_user',
    'delete_document_cascade',
    'ensure_document_queued_ingestion_job',
    'fail_ingestion_job',
    'get_admin_runtime_snapshot',
    'invalidate_retrieval_cache',
    'prune_retrieval_cache_entries',
    'reconcile_document_status',
    'reconcile_ingestion_job_state',
    'replace_document_chunks',
    'requeue_dead_letter_document',
    'smoke_test_ingestion_runtime_contract',
    'touch_retrieval_cache_entry',
    'upsert_retrieval_cache_entry',
    'yield_ingestion_job'
  ];
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any (fn_names)
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.sig);
    execute format('grant execute on function %s to service_role', fn.sig);
  end loop;
end;
$$;
