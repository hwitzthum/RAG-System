# VERCEL_HOSTING_SETUP_GUIDE_FOR_DUMMIES.md

Version: 2.5  
Date: 2026-03-06  
Last verified against Vercel/Supabase docs: 2026-03-06

## Who this is for

You want this app deployed to production on Vercel (with Supabase already set up) and need exact, safe, step-by-step instructions.

## Read this first (important reality check)

Current repository architecture is:

1. Next.js app + API routes (`app/`)  
2. Vercel ingestion runner route + cron (`/api/internal/ingestion/run`)  
3. Supabase (DB/Auth/Storage)  
4. Python worker (`worker/`) as rollback fallback only

What this means today:

- Web app + ingestion run on Vercel in production mode (`INGESTION_RUNTIME_MODE=vercel`).
- `worker/` is deprecated for production and retained as rollback fallback for one release cycle.
- Production checklist no longer requires external worker runtime.

This guide gives you:

1. Correct production Vercel deployment steps for the Vercel-first runtime.
2. Explicit rollback instructions if you temporarily need worker fallback.

---

## Do This Now (Exact Step-By-Step From Your Current Stage)

Follow these steps in order. Do not skip.

### 1. Open terminal in project

```bash
cd /Users/hwitzthum/rag-system
```

### 2. Prepare local staging config for Vercel mode

```bash
npm run infra:vercel:prepare-staging
```

Expected result:

- `INGESTION_RUNTIME_MODE=vercel`
- `CRON_SECRET` exists and is 16+ characters

### 3. Run pre-signup readiness check

```bash
npm run infra:vercel:readiness
```

Expected result right now:

- it will likely fail until Vercel CLI is installed and logged in
- it writes a report to:
  - `evaluation/reports/vercel-onboarding-readiness-latest.json`

### 4. Install Vercel CLI

```bash
npm i -g vercel
vercel --version
```

### 5. Sign up / login to Vercel

```bash
vercel login
```

Complete browser login flow.

### 6. Link this repo to your Vercel project

```bash
vercel link
```

If prompted:

1. Choose your team/scope
2. Link existing project or create new project
3. Confirm root directory is `rag-system`

Expected result:

- `.vercel/project.json` is created locally

### 7. Sync linked Vercel IDs into `.env.staging`

```bash
npm run infra:vercel:sync-ids
```

This writes:

- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

### 8. Run post-link readiness check

```bash
npm run infra:vercel:readiness:postlink
```

Goal:

- this should pass once CLI/link/env conditions are satisfied

### 9. Add environment variables in Vercel Dashboard

Vercel -> Project -> Settings -> Environment Variables

Add all required vars for both `Production` and `Preview` (see Step 3 sections below), including:

- Supabase keys
- OpenAI and BYOK vault key vars
- ingestion vars
- `CRON_SECRET`

### 10. Deploy production

```bash
vercel deploy --prod
```

### 11. Run smoke checks after deploy

1. `GET https://<your-app>.vercel.app/api/health` -> `status: ok`
2. login session works
3. query endpoint works
4. upload works and ingestion transitions to `ready`

### 12. Run release gates (precutover first)

```bash
npm run release:matrix:precutover
```

When staging has enough real data and tokens:

```bash
npm run release:matrix:strict -- --base-url https://<staging-host> --token <reader-or-admin-jwt>
```

---

## Step 0: Preconditions

1. You already completed Supabase setup.
2. Your repo is pushed to GitHub/GitLab/Bitbucket.
3. You can run:

```bash
cd /Users/hwitzthum/rag-system
npm run infra:vercel:prepare-staging
npm run infra:vercel:readiness
```

`infra:vercel:prepare-staging` automatically sets `INGESTION_RUNTIME_MODE=vercel` and creates a safe `CRON_SECRET` if needed.

---

## Step 1: Install and authenticate Vercel CLI (recommended)

```bash
npm i -g vercel
vercel login
vercel --version
```

No global install alternative:

```bash
npx vercel --help
```

---

## Step 2: Import project in Vercel Dashboard

1. Vercel Dashboard -> **Add New** -> **Project**.
2. Select your `rag-system` repository.
3. Keep these settings:
   - Framework Preset: `Next.js`
   - Root Directory: repo root (`rag-system`)
   - Build/Output: defaults
4. Do not deploy yet. Add environment variables first.

---

## Step 3: Add environment variables in Vercel

Path: **Project -> Settings -> Environment Variables**

Add to both **Production** and **Preview**.

### 3.1 Required for this app in production

- `NEXT_PUBLIC_APP_NAME=RAG System`
- `INGESTION_RUNTIME_MODE=vercel`
- `INGESTION_BATCH_SIZE=1`
- `INGESTION_LOCK_TIMEOUT_SECONDS=900`
- `SUPABASE_URL=https://<project-ref>.supabase.co`
- `SUPABASE_ANON_KEY=<publishable-or-anon-key>`
- `SUPABASE_SERVICE_ROLE_KEY=<service-role-or-secret-key>`
- `AUTH_DEV_INSECURE_BYPASS=false`
- `AUTH_RATE_LIMIT_WINDOW_SECONDS=60`
- `AUTH_RATE_LIMIT_MAX_REQUESTS=30`
- `OPENAI_API_KEY=<server-side-fallback-openai-key>`
- `OPENAI_BYOK_VAULT_KEY=<base64-encoded-32-byte-key>`
- `OPENAI_BYOK_VAULT_KEY_VERSION=1`
- `RAG_STORAGE_BUCKET=documents`

Generate `OPENAI_BYOK_VAULT_KEY` with:

```bash
openssl rand -base64 32
```

### 3.2 Retrieval/model tuning vars (set explicitly for reproducibility)

- `RAG_QUERY_EMBEDDING_MODEL=text-embedding-3-small`
- `RAG_RETRIEVAL_VERSION=1`
- `RAG_RRF_K=60`
- `RAG_RERANK_POOL_SIZE=20`
- `RAG_LLM_MODEL=gpt-4o-mini`
- `RAG_LLM_MAX_OUTPUT_TOKENS=700`
- `RAG_MIN_EVIDENCE_CHUNKS=1`
- `RAG_MIN_RERANK_SCORE=0.1`
- `RAG_DEFAULT_TOP_K=8`
- `RAG_CACHE_TTL_SECONDS=86400`
- `RAG_MAX_UPLOAD_BYTES=52428800`

### 3.3 Auth token verification (pick one pattern)

Recommended (asymmetric signing + JWKS):

- `AUTH_JWKS_URL=https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`

Legacy HS256 pattern:

- `SUPABASE_JWT_SECRET=<legacy-shared-secret>`

Important:

- Prefer JWKS and leave `SUPABASE_JWT_SECRET` unset.
- In this codebase, if `SUPABASE_JWT_SECRET` is set, it takes precedence.
- Do not set `NODE_ENV` in Vercel UI; Vercel sets it automatically.

### 3.4 Required for Vercel ingestion runtime

- `CRON_SECRET=<long-random-secret-at-least-16-chars>`

Any env var change requires a redeploy.

---

## Step 4: Deploy to production

Dashboard path:

1. Click **Deploy**.
2. Wait for build success.
3. Open your `*.vercel.app` production URL.

CLI path:

```bash
vercel link
npm run infra:vercel:sync-ids
npm run infra:vercel:readiness:postlink
vercel deploy --prod
```

---

## Step 5: Validate runtime health

1. `GET https://<your-app>.vercel.app/api/health` returns `status: ok`.
2. Login flow works (`POST /api/auth/session` + cookie set).
3. Query works (`POST /api/query`, SSE stream visible in UI).
4. BYOK vault works end-to-end:
   - `GET /api/byok/openai`
   - `PUT /api/byok/openai`
   - `DELETE /api/byok/openai`

Upload behavior check:

1. Upload PDF via UI/API (`POST /api/upload`) creates queued job.
2. Status endpoint (`GET /api/upload/:documentId`) returns latest ingestion job state.

Note: in production mode, processing to `ready` is handled by the Vercel ingestion runner + cron path.

---

## Step 6: Align Vercel Function region with Supabase region

Why: lower DB/API latency.

By default, new Vercel projects run functions in `iad1` unless changed.

If your Supabase is in EU, set region to nearby code (example `fra1`):

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs",
  "regions": ["fra1"]
}
```

Then redeploy.

---

## Step 7: Logs and incident debugging

Dashboard:

- Build logs: Deployments
- Runtime logs: Logs

CLI:

```bash
vercel logs --environment production --follow
```

Useful filters:

- `--level error`
- `--status-code 5xx`
- `--query "timeout"`

Example:

```bash
vercel logs --environment production --level error --status-code 5xx --follow
```

---

## Step 8: Local linkage for release scripts (optional)

Only needed if you run local staging/release scripts from this repo.

```bash
vercel link
vercel env pull .env.vercel --environment=production
npm run infra:vercel:sync-ids
npm run infra:vercel:readiness:postlink
```

---

## Step 9: Custom domain

1. Project -> Settings -> Domains.
2. Add domain.
3. Apply DNS records exactly as shown by Vercel.
4. Re-test:
   - `/api/health`
   - login
   - query

---

## Step 10: Rollback procedure

1. Go to Deployments.
2. Select last known-good deployment.
3. Promote rollback to production.
4. Set `INGESTION_RUNTIME_MODE=worker` in Vercel env, then redeploy.
5. Disable cron for `/api/internal/ingestion/run` in Vercel cron management.
6. Start fallback worker runtime (`worker/`) externally.
7. Re-run smoke checks:
   - `/api/health`
   - auth session
   - query
   - upload status

---

## Step 11: Vercel Cron behavior you must account for

From current Vercel docs:

- Cron invokes your path using HTTP `GET`.
- Cron targets the **production deployment URL**.
- Timezone is always UTC.
- Vercel does **not** retry failed cron invocations.
- Duplicate delivery can happen; build idempotent handlers.
- Overlapping runs can happen; use locking.
- Protect cron endpoints with `CRON_SECRET` + `Authorization: Bearer <CRON_SECRET>`.
- Hobby restrictions: cron can run once/day and execution may occur within the selected hour window.

---

## Step 12: Executable Implementation Plan For True “All Compute On Vercel”

Target outcome:

- ingestion is executed by Vercel-hosted routes/functions only
- `worker/` is no longer required in production
- upload -> queued -> processing -> ready flow works end-to-end without external worker runtime

Execution order below is designed to be implemented in sequence.

### 12.1 Build a safe migration baseline (no behavior break while migrating)

Goal: introduce feature-gated Vercel ingestion path while keeping current worker path functional.

Tasks:

1. Add new env variables in web runtime config:
   - `INGESTION_RUNTIME_MODE=worker|vercel` (default `worker`)
   - `INGESTION_BATCH_SIZE` (default 1-5)
   - `INGESTION_LOCK_TIMEOUT_SECONDS` (default aligns to current worker lock timeout)
   - `CRON_SECRET` (required when `INGESTION_RUNTIME_MODE=vercel`)
2. Update:
   - `.env.example`
   - `.env.staging.example`
   - `scripts/infrastructure/validate-env.mjs`
   - `docs/INFRASTRUCTURE_RUNBOOK.md`
3. Add explicit guard in app startup validation (`lib/config/env.ts`) for the new mode.

Acceptance checks:

1. `npm run infra:check-env:web` passes in both modes.
2. Existing upload/query features continue to work with `INGESTION_RUNTIME_MODE=worker`.

### 12.2 Move job claiming to atomic SQL functions (required for concurrent cron invocations)

Goal: prevent duplicate processing from overlapping serverless invocations.

Tasks:

1. Add Supabase migrations with RPC functions and ACL hardening:
   - `claim_ingestion_jobs(worker_name text, batch_size int, lock_timeout_seconds int)`
   - `complete_ingestion_job(job_id uuid)`
   - `fail_ingestion_job(job_id uuid, error_text text, max_retries int)`
2. Implement claim with `FOR UPDATE SKIP LOCKED` semantics and stale-lock reclaim logic.
3. Ensure document status transitions stay consistent:
   - on claim: document -> `processing`
   - on success: document -> `ready`
   - on retryable failure: document -> `queued`
   - on dead-letter: document -> `failed`

Primary files:

- `supabase/migrations/<new_timestamp>_phase12_vercel_ingestion_rpc.sql`
- `supabase/migrations/<new_timestamp>_phase12_vercel_ingestion_rpc_acl_fix.sql`

Acceptance checks:

1. Simulate concurrent claims from 2+ sessions; one job is claimed once only.
2. Existing `GET /api/upload/:documentId` reflects accurate lock/status fields.

### 12.3 Port ingestion pipeline from Python worker to TypeScript shared modules

Goal: run the same extraction/chunk/context/embedding logic inside Node runtime.

Tasks:

1. Create Node ingestion modules under `lib/ingestion/runtime/`:
   - `types.ts`
   - `repository.ts`
   - `pdf-extractor.ts`
   - `chunking.ts`
   - `context-generator.ts`
   - `embedding-provider.ts`
   - `pipeline.ts`
2. Preserve current behavior parity from `worker/src/rag_worker/*`:
   - section-aware chunking (700/120)
   - language detection fallback
   - contextual summary generation
   - embedding dimension validation
   - chunk replace/upsert behavior
3. Reuse existing app provider abstractions where possible (`lib/providers/*`) to avoid duplicate OpenAI call logic.

Acceptance checks:

1. Unit tests validate pipeline parity on fixed fixture PDFs.
2. Error scenarios map to `failed`/`dead_letter` exactly as current worker behavior.

### 12.4 Add protected ingestion runner endpoints in Next.js API

Goal: expose bounded work units suitable for serverless execution.

Tasks:

1. Add route: `app/api/internal/ingestion/run/route.ts`
2. Route behavior:
   - verify `Authorization: Bearer <CRON_SECRET>`
   - claim up to `INGESTION_BATCH_SIZE` jobs
   - process claimed jobs sequentially in one invocation
   - return JSON metrics (`claimed`, `completed`, `failed`, `dead_lettered`, `duration_ms`)
3. Configure runtime:
   - `export const runtime = "nodejs"`
   - `export const maxDuration = <bounded-value-based-on-pdf-size>` (set from measured staging timings)
4. Add optional manual admin trigger route for controlled backfills (same auth controls, no public access).

Acceptance checks:

1. Manual invocation processes queued jobs to completion.
2. Duplicate/overlap invocations do not double-process jobs.

### 12.5 Wire scheduler with Vercel Cron

Goal: automatically drain queue in production.

Tasks:

1. Add cron entry in `vercel.json` (production only):
   - path: `/api/internal/ingestion/run`
   - schedule: start with low frequency (for example every 2-5 minutes), then tune
   - current repo default: `*/5 * * * *`
2. Add `CRON_SECRET` in Vercel env.
3. Ensure handler validates bearer token and returns non-2xx on auth failure.
4. Add alerting/log checks for failed cron runs and queue backlog growth.
   - use `npm run obs:ingestion:check` to validate queue/stale/cron-progress gates

Acceptance checks:

1. New uploads are automatically processed without external worker.
2. Cron logs show stable cadence and no sustained backlog.

### 12.6 Remove external worker dependency from production path

Goal: make docs/code/runbooks truthful for Vercel-only hosting.

Status: implemented on 2026-03-06.

Tasks:

1. Update docs:
   - `README.md`
   - `docs/DEVELOPMENT_RUNBOOK.md`
   - `docs/INFRASTRUCTURE_RUNBOOK.md`
   - `docs/RELEASE_RUNBOOK.md`
   - this file
2. Mark `worker/` as deprecated for production (retain only as fallback until one release cycle passes).
3. Remove `infra:check-env:worker` from required production gates.
4. Add migration note and rollback path:
   - rollback toggles `INGESTION_RUNTIME_MODE=worker`
   - disable cron

Acceptance checks:

1. Production checklist contains no mandatory external worker requirement.
2. Release runbook rollback instructions are tested in staging.

### 12.7 Validation matrix before production cutover

Run and archive outputs:

1. `npm run check`
2. `npm run test:security`
3. `npm run eval:benchmark:dry`
4. `npm run perf:soak:verify -- --window-hours 24 --min-completed-jobs 25 --min-ready-documents 25 --max-p95-completion-ms 900000 --max-dead-letter-growth 0 --max-duplicate-write-errors 0`
5. `npm run release:readiness:precutover`
6. Final cutover gate: run live benchmark + strict readiness
   - `npm run eval:benchmark`
   - `npm run release:readiness`

Matrix shortcut commands:

1. `npm run release:matrix:precutover`
2. `npm run release:matrix:strict -- --base-url https://<staging-host> --token <reader-or-admin-jwt>`

Staging soak test requirements:

1. Upload at least 25 PDFs.
2. Verify all jobs end in `completed` with `documents.status=ready`.
3. Verify no stuck `processing` jobs beyond lock timeout.
4. Verify dead-letter does not trend upward, p95 completion time stays below threshold, and duplicate-write errors stay at zero.

Cutover criteria:

1. Zero duplicate chunk writes from concurrent invocations.
2. No dead-letter growth trend under normal load.
3. p95 ingestion completion time meets your operational target.

### 12.8 Implementation checklist (copy/paste for execution tracking)

1. Add env + validation updates (`INGESTION_*`, `CRON_SECRET`).
2. Ship SQL migration with atomic claim/finalize/fail RPCs.
3. Port Python ingestion pipeline to `lib/ingestion/runtime/*`.
4. Add internal ingestion API route + auth + bounded execution.
5. Add `vercel.json` cron schedule + configure `CRON_SECRET`.
6. Run staging soak + quality/security/release gates.
7. Switch `INGESTION_RUNTIME_MODE=vercel` in production.
8. Remove external worker from production checklist and runbooks after successful cutover window.

---

## Production checklist (what must be true now)

1. Vercel deployment green in production.
2. Required env vars set in Production + Preview.
3. Supabase reachable from Vercel functions.
4. BYOK vault flow works in UI and API.
5. Ingestion processor is running via Vercel cron (`/api/internal/ingestion/run`).
6. Worker runtime is treated as rollback fallback only (not a production prerequisite).
7. `npm run check` and `npm run test:security` pass.

---

## Plan recommendation

For production, use at least **Vercel Pro**.

Why:

- Better operational limits and controls than Hobby.
- Multi-region options and more predictable runtime behavior for production workloads.

Pricing reference:

- [https://vercel.com/pricing](https://vercel.com/pricing)

---

## Official sources used

Vercel:

- Deployments: [https://vercel.com/docs/deployments](https://vercel.com/docs/deployments)
- Next.js on Vercel: [https://vercel.com/docs/frameworks/full-stack/nextjs](https://vercel.com/docs/frameworks/full-stack/nextjs)
- Environment variables: [https://vercel.com/docs/environment-variables](https://vercel.com/docs/environment-variables)
- Vercel CLI: [https://vercel.com/docs/cli](https://vercel.com/docs/cli)
- `vercel env`: [https://vercel.com/docs/cli/env](https://vercel.com/docs/cli/env)
- `vercel pull`: [https://vercel.com/docs/cli/pull](https://vercel.com/docs/cli/pull)
- `vercel logs`: [https://vercel.com/docs/cli/logs](https://vercel.com/docs/cli/logs)
- Cron jobs: [https://vercel.com/docs/cron-jobs](https://vercel.com/docs/cron-jobs)
- Managing cron jobs: [https://vercel.com/docs/cron-jobs/manage-cron-jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
- Function config/limits: [https://vercel.com/docs/functions/configuring-functions](https://vercel.com/docs/functions/configuring-functions)
- Function regions: [https://vercel.com/docs/functions/configuring-functions/region](https://vercel.com/docs/functions/configuring-functions/region)
- Pricing: [https://vercel.com/pricing](https://vercel.com/pricing)

Supabase:

- JWT verification and JWKS endpoint: [https://supabase.com/docs/guides/auth/jwts](https://supabase.com/docs/guides/auth/jwts)
- API keys: [https://supabase.com/docs/guides/api/api-keys](https://supabase.com/docs/guides/api/api-keys)

End of file
