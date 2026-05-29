# Database Migrations

## Applied Migration Sequence

1. `supabase/migrations/202603060001_phase2_bootstrap.sql`

- enables `pgvector`
- creates/configures `documents` storage bucket
- applies storage bucket policies for `admin` and `reader`

2. `supabase/migrations/202603060002_phase3_core_schema.sql`

- creates core tables:
- `documents`
- `document_chunks`
- `retrieval_cache`
- `ingestion_jobs`
- `query_history`
- creates indexes (vector, full-text, lifecycle)
- enables and configures RLS policies

3. `supabase/migrations/202603060003_phase7_retrieval_rpc.sql`

- creates retrieval RPC function `match_document_chunks(...)`
- grants execute to `authenticated` and `service_role`

4. `supabase/migrations/202603060004_phase12_openai_byok_vault.sql`

- creates `user_openai_keys` BYOK vault table
- adds owner-only RLS policies for encrypted key records
- wires `updated_at` trigger + operational indexes

5. `supabase/migrations/202605290001_explicit_data_api_grants.sql`

- codifies explicit Data API grants for every API-facing public table
- revokes the redundant `anon` table grants (no policy targets `anon`)
- required because Supabase is dropping automatic role grants for tables
  created after 2026-10-30 (supabase/discussions/45329)

## Data API grant convention

Supabase no longer auto-exposes new `public` tables to the Data API
(PostgREST / GraphQL / supabase-js). Every migration that creates a table
**must** declare its grants explicitly, immediately after enabling RLS — never
rely on the implicit grant.

For a table reached through the Data API by signed-in users:

```sql
alter table public.your_table enable row level security;

revoke all on table public.your_table from public;
revoke all on table public.your_table from anon;            -- omit `anon` unless an anon RLS policy exists
grant select, insert, update, delete on table public.your_table to authenticated;
grant all on table public.your_table to service_role;
```

For a backend-only table (no client access), follow the
`metric_events` / `rate_limit_buckets` pattern: revoke from `public`, `anon`
and `authenticated`, then `grant all ... to service_role` only.

## Validation

Run static migration checks:

```bash
npm run db:validate:migrations
```

Run Supabase migration apply/rollback checks (requires Supabase CLI + linked project):

```bash
supabase db reset --local
supabase db push --local
```
