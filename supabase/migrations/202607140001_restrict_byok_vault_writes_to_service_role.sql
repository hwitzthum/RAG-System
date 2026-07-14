-- Restrict user_openai_keys / user_cohere_keys / user_anthropic_keys to
-- service-role-only access via the Data API.
--
-- These tables store AES-256-GCM encrypted BYOK provider API keys. Every
-- legitimate read/write goes through lib/providers/byok-vault.ts, which
-- always uses the service-role client (getSupabaseAdminClient()) so that:
--   - format validation (sanitizeLooseProviderApiKey / sanitizeOpenAiApiKey)
--   - encryption (encryptApiKey, AES-256-GCM with a fresh IV)
--   - per-route rate limiting (handleByokPut: 10 writes / 15 min)
--   - audit logging (logAuditEvent)
-- all run before anything is persisted.
--
-- The owner-scoped RLS policies added in 202603060004_phase12_openai_byok_vault.sql
-- and 202603140002_multi_provider_byok.sql (`*_owner_select/insert/update/delete`,
-- USING/WITH CHECK (user_id = auth.uid())) combined with the blanket
-- `grant select, insert, update, delete ... to authenticated` added in
-- 202605290001_explicit_data_api_grants.sql let a signed-in user write
-- directly to their own vault row via supabase-js / PostgREST -- bypassing
-- every one of the guarantees above. This is scoped to the caller's own row
-- (no cross-tenant impact -- `user_id = auth.uid()` is correctly enforced),
-- but there is no legitimate reason for the Data API to expose encrypted
-- key material at all. The frontend never reads these tables directly
-- either (BYOK status/update/delete all go through the API routes in
-- app/api/byok/*/route.ts, which use the service-role client).
--
-- Fix: lock these three tables down to the "backend-only table" convention
-- already documented in database/migrations.md (the metric_events /
-- rate_limit_buckets pattern) -- drop the owner policies and revoke the
-- Data API grants entirely, leaving service_role as the only accessor.

do $$
declare
  vault_table text;
  vault_tables constant text[] := array[
    'user_openai_keys',
    'user_cohere_keys',
    'user_anthropic_keys'
  ];
begin
  foreach vault_table in array vault_tables loop
    execute format('drop policy if exists %I on public.%I', vault_table || '_owner_select', vault_table);
    execute format('drop policy if exists %I on public.%I', vault_table || '_owner_insert', vault_table);
    execute format('drop policy if exists %I on public.%I', vault_table || '_owner_update', vault_table);
    execute format('drop policy if exists %I on public.%I', vault_table || '_owner_delete', vault_table);

    execute format('revoke all on table public.%I from public', vault_table);
    execute format('revoke all on table public.%I from anon', vault_table);
    execute format('revoke all on table public.%I from authenticated', vault_table);
    execute format('grant all on table public.%I to service_role', vault_table);
  end loop;
end;
$$;
