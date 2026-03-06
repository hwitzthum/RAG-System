# INFRASTRUCTURE_RUNBOOK.md

Version: 1.0  
Date: 2026-03-06

## Purpose

Operational runbook for Phase 2 infrastructure provisioning and validation.

## Provisioning Scope

- Vercel project linkage for Next.js deployment
- Supabase project linkage for DB/Auth/Storage
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
npm run infra:preflight
```

## 2. Link/Create Vercel Project

```bash
vercel link
vercel env pull .env.vercel
```

Populate `.env.staging` with `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` after linking.

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
npm run infra:check-env:worker
```

## 6. Exit Criteria for Phase 2

- Vercel project linked and accessible
- Supabase project linked and accessible
- `pgvector` extension enabled in remote DB
- `documents` storage bucket exists with correct policies
- staging env file passes validation checks

## Notes

Actual cloud reachability depends on user credentials and remote project setup. This runbook and scripts define the reproducible provisioning path.
