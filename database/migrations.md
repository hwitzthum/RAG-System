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
