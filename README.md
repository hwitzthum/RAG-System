# RAG System

Phase 1-10 repository scaffold for the production-ready multilingual RAG platform.

## Structure

- `app/`: Next.js App Router UI and API routes
- `components/`: reusable UI components
- `lib/`: core configuration, auth/security, and shared contracts
- `worker/`: Python ingestion worker scaffold
- `database/`: SQL migration docs and bootstrap notes
- `supabase/`: Supabase CLI config and migration files
- `evaluation/`: benchmark datasets and scripts (placeholder)
- `prompts/`: prompt templates (placeholder)
- `docs/`: canonical architecture, implementation, evaluation, and runbooks
- `scripts/infrastructure/`: preflight and env validation scripts
- `scripts/database/`: migration validation scripts
- `tests/`: security validation tests

## Web App Quick Start

```bash
npm install
cp .env.example .env.local
npm run dev
```

Health endpoint: `GET /api/health`

## Validation Commands

```bash
npm run check
npm run test:security
npm run test:worker
npm run infra:check-env:web
npm run infra:check-env:staging
npm run infra:preflight
npm run db:validate:migrations
npm run eval:dataset:validate
npm run eval:benchmark:dry
```

## Upload API (Phase 5)

- `POST /api/upload` (`admin`): stores PDF in Supabase Storage and enqueues ingestion job
- `GET /api/upload/{documentId}` (`reader|admin`): returns document + latest ingestion job status

## Worker Quick Start

```bash
cd worker
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
cp .env.example .env
python -m rag_worker.main
```

Phase 6 pipeline includes:

- PDF extraction with optional OCR fallback
- section-aware chunking (`700` target tokens, `120` overlap)
- contextual chunk summaries
- embedding generation and chunk upsert
- retry with bounded attempts and dead-letter transitions
- stale lock recovery using `WORKER_LOCK_TIMEOUT_SECONDS`

Phase 7 retrieval core includes:

- query normalization and language detection
- hybrid retrieval (`pgvector` RPC + keyword search)
- reciprocal rank fusion
- reranker integration with ranked candidate output and trace metadata

Phase 8 retrieval cache includes:

- retrieval cache lookup before retrieval and reranking
- cache write on retrieval miss with configurable TTL (`RAG_CACHE_TTL_SECONDS`)
- retrieval-version-based invalidation behavior for stale cache entries

Phase 9 answer generation includes:

- provider abstraction for embedding, reranker, and LLM calls
- grounded answer prompt templates under `prompts/`
- explicit insufficient-evidence fallback behavior
- `POST /api/query` Server-Sent Events (SSE) streaming (`meta`, `token`, `final`, `done`)

Phase 10 frontend UX includes:

- chat interface consuming SSE token streams
- citation rendering with source links
- admin upload controls and ingestion status visibility
- query-history timeline via `GET /api/query-history`
- managed OpenAI BYOK vault flow (`GET|PUT|DELETE /api/byok/openai`) with server-side encryption and no browser-side secret persistence

Phase 11 evaluation framework includes:

- multilingual labeled dataset at `evaluation/evaluation_queries.json` (`>=200` records, `>=40` per language)
- dataset generation and validation scripts under `scripts/evaluation/`
- benchmark runner producing run artifacts (`evaluation/runs/`) and release reports (`evaluation/reports/`)

Phase 11 commands:

```bash
npm run eval:dataset:generate
npm run eval:dataset:validate
npm run eval:benchmark:dry
# staging benchmark (requires live env + providers)
npm run eval:benchmark
```

Phase 12 production hardening commands:

```bash
npm run obs:validate
npm run perf:load:dry
npm run perf:resilience:dry
npm run release:readiness
```

Live hardening checks:

```bash
npm run perf:load -- --base-url https://<staging-host> --token <reader-or-admin-jwt>
npm run perf:resilience -- --base-url https://<staging-host> --token <reader-or-admin-jwt>
```
