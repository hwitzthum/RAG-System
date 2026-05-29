-- Explicit Data API grants for all API-facing public tables.
--
-- Why: Supabase is removing the automatic role grants that today expose new
-- public-schema tables to the Data API / PostgREST / supabase-js
-- (github.com/orgs/supabase/discussions/45329). The new default lands for
-- existing projects on 2026-10-30 and applies to tables created after that
-- date. Our existing tables keep their auto-granted privileges on the live
-- database, but those grants live nowhere in version control -- so a rebuild
-- from migrations after the cutover (supabase db reset, a fresh preview
-- branch, or a new environment) would create these tables WITHOUT Data API
-- access and supabase-js would fail with permission errors despite correct
-- RLS. This migration codifies the grants so the schema is self-sufficient.
--
-- Privilege model (matches the established service_role-only pattern used by
-- public.metric_events and public.rate_limit_buckets):
--   * anon          -> revoked. No RLS policy targets anon, so anon already has
--                      zero row access; removing the dead table grant is
--                      behaviour-preserving and tightens the live database.
--   * authenticated -> standard DML, gated by the per-table RLS policies
--                      defined in the phase 3 / phase 12 migrations.
--   * service_role  -> full access for backend / RPC operations.
--
-- GRANT/REVOKE are idempotent, so this migration is safe to re-run and safe to
-- apply to the live database (it only tightens the redundant anon grants).

do $$
declare
  api_table text;
  api_tables constant text[] := array[
    'documents',
    'document_chunks',
    'retrieval_cache',
    'ingestion_jobs',
    'query_history',
    'user_openai_keys',
    'user_anthropic_keys',
    'user_cohere_keys'
  ];
begin
  foreach api_table in array api_tables loop
    -- Revoke first so the live database (where the old auto-grant gave
    -- authenticated all privileges, incl. TRUNCATE/TRIGGER/REFERENCES) and a
    -- fresh rebuild converge on the same minimal privilege set below.
    execute format('revoke all on table public.%I from public', api_table);
    execute format('revoke all on table public.%I from anon', api_table);
    execute format('revoke all on table public.%I from authenticated', api_table);
    execute format(
      'grant select, insert, update, delete on table public.%I to authenticated',
      api_table
    );
    execute format('grant all on table public.%I to service_role', api_table);
  end loop;
end;
$$;
