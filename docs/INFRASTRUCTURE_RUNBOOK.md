# INFRASTRUCTURE_RUNBOOK.md

Version: 1.3  
Date: 2026-03-06

## Purpose

Operational runbook for Phase 2 provisioning and Phase 12.6 Vercel-first production runtime alignment.

## Provisioning Scope

- Vercel project linkage for Next.js deployment
- Supabase project linkage for DB/Auth/Storage
- Vercel cron-driven ingestion runtime provisioning
- Storage bucket provisioning (`documents`)
- `pgvector` extension enablement
- staging env validation

## Prerequisites

- `vercel` CLI installed and authenticated
- `supabase` CLI installed and authenticated
- `psql` client installed
- `.env.staging` created from `.env.staging.example`

## 1. Run Preflight

```bash
npm run infra:vercel:prepare-staging
npm run infra:vercel:readiness
npm run infra:preflight
```

`infra:vercel:prepare-staging` ensures `CRON_SECRET` exists for the protected ingestion trigger.

## 2. Link/Create Vercel Project

```bash
vercel link
vercel env pull .env.vercel
npm run infra:vercel:sync-ids
npm run infra:vercel:readiness:postlink
```

Set ingestion trigger configuration for the production path:

- `INGESTION_BATCH_SIZE=1`
- `INGESTION_LOCK_TIMEOUT_SECONDS=900`
- `CRON_SECRET=<long-random-secret>` (required)

Local queue draining remains available through the TypeScript worker:

- disable Vercel cron job for `/api/internal/ingestion/run`
- run `npm run ingestion:worker`

## 3. Link/Create Supabase Project

```bash
supabase login
supabase link --project-ref "$SUPABASE_PROJECT_REF"
```

## 4. Provision Phase 2 Supabase Infrastructure

```bash
supabase db push
```

This applies migration:

- `supabase/migrations/202603060001_phase2_bootstrap.sql`

## 5. Validate Environment Contracts

```bash
npm run infra:check-env:staging
npm run infra:check-env:web
```

## 6. Exit Criteria for Phase 2

- Vercel project linked and accessible
- Supabase project linked and accessible
- `pgvector` extension enabled in remote DB
- `documents` storage bucket exists with correct policies
- `CRON_SECRET` configured for protected cron execution
- staging env file passes validation checks

## Notes

Actual cloud reachability depends on user credentials and remote project setup. This runbook and scripts define the reproducible provisioning path.
