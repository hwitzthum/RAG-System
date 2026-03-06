# PROJECT_RULES.md

Version: 3.1  
Date: 2026-03-06

## Purpose

Define enforceable engineering rules for a production-ready multilingual RAG system.

## Source of Truth and Precedence

1. [`RAG_SYSTEM_SPEC.md`](/Users/hwitzthum/rag-system/docs/RAG_SYSTEM_SPEC.md) is the canonical product and architecture specification.
2. [`PROJECT_RULES.md`](/Users/hwitzthum/rag-system/docs/PROJECT_RULES.md) defines mandatory implementation and quality constraints.
3. [`RAG_IMPLEMENTATION_PLAN.md`](/Users/hwitzthum/rag-system/docs/RAG_IMPLEMENTATION_PLAN.md) defines execution order and delivery gates.
4. [`RAG_EVALUATION_FRAMEWORK.md`](/Users/hwitzthum/rag-system/docs/RAG_EVALUATION_FRAMEWORK.md) defines quality measurement and release thresholds.

If documents conflict, follow this precedence order.

## Architecture Rules (Mandatory)

- User-facing app: Next.js App Router, TypeScript, deployed on Vercel.
- Data platform: Supabase PostgreSQL + pgvector + Supabase Storage.
- Ingestion runtime: Vercel-executed ingestion runner + cron (`/api/internal/ingestion/run`) for production.
- Worker runtime: fallback-only rollback path, not a production prerequisite.
- Retrieval: hybrid retrieval (vector + keyword) and reranking are mandatory.
- Retrieval cache: mandatory, executed before retrieval and reranking.
- Contextual chunk summaries: mandatory during ingestion.
- Provider abstraction: embedding, reranker, and generation providers must be pluggable.

## Access and Security Rules (Mandatory)

- Authentication required for all user actions.
- Role model: `admin`, `reader`.
- `POST /api/upload` is `admin` only.
- Query endpoints are `reader` and `admin`.
- Rate limiting required for query endpoints.
- Audit logging required for uploads, queries, and role-protected actions.
- Secrets must be loaded from environment variables only.

## Retrieval and Answering Rules (Mandatory)

Pipeline order must be:

`normalize query -> detect language -> cache lookup -> hybrid retrieval -> rerank -> answer generation -> stream`

Additional constraints:

- Answers must not skip retrieval.
- Every answer must include citations with `document_id`, `page_number`, and `chunk_id`.
- If evidence is insufficient, answer must return an explicit insufficient-evidence response.
- Cache key must include `normalized_query + language + retrieval_version + top_k`.

## Supported Languages

- English (`EN`)
- German (`DE`)
- French (`FR`)
- Italian (`IT`)
- Spanish (`ES`)

All ingestion, retrieval, and evaluation flows must support the same language set.

## Folder Ownership

- `app/`: Next.js UI and API routes.
- `lib/`: retrieval, cache, provider abstraction, shared app logic.
- `worker/`: ingestion fallback runtime retained for rollback scenarios.
- `database/`: SQL migrations, indexes, RLS policies.
- `evaluation/`: evaluation datasets, benchmark runners, reports.
- `prompts/`: system prompts and templates.
- `docs/`: architecture, plan, evaluation, and operational documentation.

## Coding and Module Rules

- TypeScript is required in the Next.js codebase.
- Fallback worker may use Python for extraction robustness.
- File size target: under 400 lines.
- Single responsibility per module.
- Runtime configuration must be validated at startup.
- Public interfaces and types must be explicit and versioned when changed.

## Data and Cache Rules

- Ingestion jobs must be idempotent.
- Document updates must increment `retrieval_version`.
- Cache invalidation must occur on retrieval version changes.
- Default cache TTL is 24h and must be configurable.

## Observability Rules

Structured logging is mandatory for:

- queries and latency
- cache hits/misses
- retrieval candidates and scores
- reranker scores
- model calls and error classes
- ingestion job lifecycle events

## Testing and Release Rules

Minimum CI gates before release:

- type checks and lint pass
- unit and integration tests pass
- migration validation pass
- retrieval and hallucination benchmarks meet thresholds
- security and RBAC tests pass

Release is blocked if evaluation thresholds from [`RAG_EVALUATION_FRAMEWORK.md`](/Users/hwitzthum/rag-system/docs/RAG_EVALUATION_FRAMEWORK.md) are not met.
