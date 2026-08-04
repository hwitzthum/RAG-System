# DATABASE_RUNBOOK.md

Version: 1.0  
Date: 2026-03-06

## Purpose

Runbook for Phase 3 database schema setup and validation.

## Scope

- apply Phase 2 and Phase 3 migrations in order
- validate schema objects, indexes, and RLS presence
- verify migration reset/push cycle in development

## Prerequisites

- Supabase CLI installed and authenticated
- project linked via `supabase link --project-ref ...`
- local Docker available if running local Supabase stack

## Migration Files

- `supabase/migrations/202603060001_phase2_bootstrap.sql`
- `supabase/migrations/202603060002_phase3_core_schema.sql`

## 1. Static Migration Validation

```bash
npm run db:validate:migrations
```

## 2. Local Apply/Reset Validation

```bash
supabase db reset --local
supabase db push --local
```

## 3. Remote Staging Apply

```bash
supabase db push
```

Merging a migration to `main` runs this automatically via
`.github/workflows/supabase-migrations.yml`.

### Deploy credential expiry

`.github/workflows/supabase-connectivity.yml` runs `supabase db push --dry-run`
daily, and on any pull request touching `supabase/migrations/**`. It applies
nothing; it verifies that a real push _would_ work.

It exists because the apply workflow only triggers on migration changes, so
nothing exercised the deploy credentials between migration PRs.
`SUPABASE_DB_PASSWORD` went stale after 2026-07-14 and that was invisible until
a merge on 2026-08-04 needed it — three weeks in which any migration would have
silently failed to deploy.

The two credentials fail differently:

| Symptom                                                                        | Cause                                                                                                                           | Fix                                                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `Link project` step fails on privileges                                        | `SUPABASE_ACCESS_TOKEN` expired                                                                                                 | Regenerate at Account → Access Tokens, update the repo secret                                                                 |
| `failed SASL auth (FATAL: password authentication failed for user "postgres")` | `SUPABASE_DB_PASSWORD` stale                                                                                                    | Settings → Database → Reset database password, update the repo secret                                                         |
| `Remote migration versions not found in local migrations directory`            | A migration was applied out of band (e.g. `mcp__supabase__apply_migration`), so remote history holds versions with no repo file | Either rename/split the repo files to match the recorded versions, or `supabase migration repair --status reverted <version>` |

A green run prints `Remote database is up to date.` when nothing is pending.

## 4. Post-Apply Verification Queries

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('documents', 'document_chunks', 'retrieval_cache', 'ingestion_jobs', 'query_history');

select extname from pg_extension where extname in ('vector', 'pgcrypto');

select schemaname, tablename, policyname
from pg_policies
where schemaname in ('public', 'storage')
order by schemaname, tablename, policyname;
```

## Exit Criteria

- all five public tables exist
- required indexes exist
- RLS is enabled on all public tables
- expected policies are present
- migration reset/push cycle succeeds in development
