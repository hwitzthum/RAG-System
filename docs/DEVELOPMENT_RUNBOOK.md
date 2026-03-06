# DEVELOPMENT_RUNBOOK.md

Version: 2.0  
Date: 2026-03-06

## Purpose

Local setup and validation runbook for Phase 1 to Phase 11 implementation.

## Prerequisites

- Node.js 20+ and npm
- Python 3.11+

## Web Service Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

## Web Service Validation

```bash
npm run check
npm run test:security
npm run infra:check-env:web
```

## Worker Setup

```bash
cd worker
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
cp .env.example .env
python -m rag_worker.main
```

## Worker Validation (Phase 6)

```bash
python3 -m py_compile worker/src/rag_worker/*.py worker/tests/test_*.py
npm run test:worker
```

## Infrastructure Validation (Phase 2)

```bash
cp .env.staging.example .env.staging
npm run infra:check-env:staging
npm run infra:preflight
```

## Database Validation (Phase 3)

```bash
npm run db:validate:migrations
```

For full apply/rollback checks, run:

```bash
supabase db reset --local
supabase db push --local
```

## Evaluation Validation (Phase 11)

```bash
npm run eval:dataset:generate
npm run eval:dataset:validate
npm run eval:benchmark:dry
```

For staging benchmark execution:

```bash
npm run eval:benchmark
```

Artifacts are written to:

- `evaluation/runs/benchmark-<timestamp>.json`
- `evaluation/reports/benchmark-<timestamp>.md`
- `evaluation/runs/latest.json`
- `evaluation/reports/latest.md`

## Production Hardening Validation (Phase 12)

```bash
npm run obs:validate
npm run perf:load:dry
npm run perf:resilience:dry
npm run release:readiness
```

For staging hardening execution:

```bash
npm run perf:load -- --base-url https://<staging-host> --token <reader-or-admin-jwt>
npm run perf:resilience -- --base-url https://<staging-host> --token <reader-or-admin-jwt>
```

Artifacts are written to:

- `evaluation/performance/load-test-<timestamp>.json`
- `evaluation/performance/load-test-latest.json`
- `evaluation/performance/resilience-<timestamp>.json`
- `evaluation/performance/resilience-latest.json`
- `evaluation/reports/release-readiness-<timestamp>.md`
- `evaluation/reports/release-readiness-latest.md`

## Phase 1 Definition of Done Checklist

- Next.js App Router scaffold in TypeScript
- Python worker scaffold exists
- Shared contracts exist in `lib/contracts`
- Environment schema validation exists in `lib/config/env.ts`
- Local runbook exists and is executable

## Phase 2 Definition of Done Checklist

- Vercel configuration scaffold exists (`vercel.json`)
- Supabase CLI config and migration exist (`supabase/`)
- `pgvector` + storage bucket bootstrap SQL exists
- staging env validation scripts exist and run

## Phase 3 Definition of Done Checklist

- core schema migration exists for five required tables
- required indexes and RLS policies exist in migration
- static migration validation script exists and passes
- migration apply/rollback commands documented

## Phase 4 Definition of Done Checklist

- authenticated session flow endpoint exists
- role checks are enforced in API routes and reflected in UI actions
- query endpoint rate limiter is active
- audit log events are emitted for privileged and data-impacting actions
- security test command exists and passes

## Phase 5 Definition of Done Checklist

- upload endpoint stores PDFs in Supabase Storage
- upload endpoint creates `documents` and `ingestion_jobs` records
- upload endpoint returns queued job status for new uploads
- duplicate uploads are deduplicated by checksum/idempotency behavior
- upload status endpoint exists for document/job lifecycle visibility

## Phase 6 Definition of Done Checklist

- worker extraction path includes optional OCR fallback
- section chunking uses target/overlap token settings (`700`/`120` defaults)
- chunk contexts are generated before embedding
- embeddings are generated and persisted to `document_chunks`
- failed jobs retry with bounded attempts and dead-letter transitions
- stale `processing` job locks are reclaimed after lock timeout
- reprocessing keeps deterministic, unique chunk indexes per document

## Phase 7 Definition of Done Checklist

- query normalization is applied before retrieval
- language detection resolves one of `EN|DE|FR|IT|ES`
- hybrid retrieval runs vector and keyword retrieval paths
- reciprocal rank fusion combines vector and keyword candidate lists
- reranker produces final ranked candidates
- query response includes retrieval trace metadata and selected chunk ids
- retrieval migration adds and validates `match_document_chunks` RPC

## Phase 8 Definition of Done Checklist

- cache key includes normalized query + language + retrieval version + topK
- cache lookup runs before retrieval and reranking
- cache miss writes ranked retrieval results into `retrieval_cache`
- cache TTL is enforced via `expires_at` and `RAG_CACHE_TTL_SECONDS`
- old retrieval versions are invalidated from cache
- repeated query path returns `cacheHit=true` from retrieval trace

## Phase 9 Definition of Done Checklist

- provider abstraction exists for embedding, reranker, and LLM
- grounded answer prompt templates are implemented in `prompts/`
- insufficient-evidence fallback response is enforced
- query API returns SSE stream (`meta`, `token`, `final`, `done`)
- final SSE event includes answer + citation metadata

## Phase 10 Definition of Done Checklist

- frontend chat consumes SSE token stream end-to-end
- citations are rendered per answer with source links
- admin upload UI supports PDF upload and status visibility
- query-history UI reads from `GET /api/query-history`
- responsive layout works for desktop and mobile interactions

## Phase 11 Definition of Done Checklist

- evaluation dataset exists at `evaluation/evaluation_queries.json`
- dataset contains `>=200` labeled queries with `>=40` per language (`EN|DE|FR|IT|ES`)
- dataset schema validation script exists and passes
- benchmark runner executes uncached + cached query cycle per record
- benchmark artifacts capture retrieval traces, answer/citation data, latency, and failure analysis fields
- release report generation includes threshold gate pass/fail and per-language breakdown

## Phase 12 Definition of Done Checklist

- observability dashboard config exists and validates (`npm run obs:validate`)
- alert rule config exists and validates (`npm run obs:validate`)
- load test runner produces artifact in `evaluation/performance/`
- resilience runner produces artifact in `evaluation/performance/`
- release readiness report is generated from benchmark + hardening artifacts
- rollback and launch runbook documented in `docs/RELEASE_RUNBOOK.md`
