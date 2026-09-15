# RAG_SYSTEM_SPEC.md

Version: 3.0  
Date: 2026-03-06

## Overview

Production-ready multilingual Retrieval-Augmented Generation (RAG) system for approximately 350 PDF brochures.

Primary goals:

- reliable multilingual retrieval
- grounded answers with citations
- low latency via retrieval caching
- operationally safe ingestion and query workflows

## Scope

### In Scope

- PDF upload, storage, ingestion, and re-ingestion
- multilingual retrieval and answer generation (`EN`, `DE`, `FR`, `IT`, `ES`)
- role-based access (`admin`, `reader`)
- streaming chat answers with citations
- evaluation pipeline with release thresholds

### Out of Scope (v1)

- public anonymous access
- tenant isolation across organizations
- fine-tuning custom base models

## Canonical Architecture

`PDF upload -> ingestion job queue -> extraction -> section chunking -> contextual summaries -> embeddings -> document_chunks`

`query -> normalize -> language detect -> retrieval cache -> hybrid retrieve -> rerank -> generate grounded answer -> stream`

### Runtime Components

1. Next.js service (Vercel)
- chat UI
- upload UI
- query APIs
- auth and RBAC enforcement

2. Ingestion runtime (Vercel cron route in production; TypeScript worker as fallback)
- pulls ingestion jobs from Postgres
- runs extraction/chunking/context/embedding pipeline
- writes chunk and job state updates

3. Supabase
- PostgreSQL with `pgvector`
- Storage bucket for source PDFs
- Auth and access control integration

## Hosting and Deployment Topology

- Frontend/API: Vercel (Next.js, region `fra1`)
- Database/Storage/Auth: Supabase
- Ingestion (production): runs inside the Vercel deployment. A Vercel cron (`vercel.json`, every 2 minutes) calls `/api/internal/ingestion/run` with `Authorization: Bearer <CRON_SECRET>`. Each invocation stops starting new work within its 100-second budget (`maxDuration` 120s), and a document too large for one invocation checkpoints and resumes on the next tick. `POST /api/upload` and `POST /api/upload/batch` also schedule an ingestion run right after responding, so new documents start without waiting for the cron.
- Worker (fallback only): the TypeScript worker (`npm run ingestion:worker`) runs the same pipeline as a long-lived polling process. It is a local and rollback path, not a production prerequisite; disable the Vercel cron job before draining the queue with it.

## Public APIs

### `POST /api/upload` (`reader`, `admin`)

Purpose: upload PDF and enqueue ingestion.

Request:

- multipart file (`.pdf`)
- optional metadata: `title`, `language_hint`

Response:

- `documentId`
- `ingestionJobId`
- `status` (`queued`)

### `POST /api/query` (`reader`, `admin`)

Purpose: retrieve grounded answer with citations.

Request JSON:

- `query` (required)
- `conversationId` (optional)
- `languageHint` (optional)
- `topK` (optional, default controlled by server)

Response:

- SSE stream for tokens
- final event includes:
- `answer`
- `citations[]`
- `retrievalMeta` (`cacheHit`, `latencyMs`, selected chunk ids)

### `GET /api/query-history` (`reader`, `admin`)

Purpose: return persisted conversation history and citation metadata.

## Data Model

### `documents`

- `id` (uuid, pk)
- `storage_path` (text, unique)
- `sha256` (text, unique)
- `title` (text)
- `language` (text)
- `status` (`queued|processing|ready|failed`)
- `ingestion_version` (int)
- `created_at`, `updated_at`

### `document_chunks`

- `id` (uuid, pk)
- `document_id` (fk -> documents.id)
- `chunk_index` (int)
- `page_number` (int)
- `section_title` (text)
- `content` (text)
- `context` (text)
- `language` (text)
- `embedding` (vector)
- `tsv` (tsvector)
- `created_at`

### `retrieval_cache`

- `cache_key` (text, pk)
- `normalized_query` (text)
- `language` (text)
- `retrieval_version` (int)
- `chunk_ids` (uuid[])
- `payload` (jsonb)
- `hit_count` (int)
- `created_at`, `expires_at`

### `ingestion_jobs`

- `id` (uuid, pk)
- `document_id` (fk -> documents.id)
- `status` (`queued|processing|completed|failed|dead_letter`)
- `attempt` (int)
- `last_error` (text)
- `locked_at` (timestamptz)
- `locked_by` (text)
- `created_at`, `updated_at`

### `query_history`

- `id` (uuid, pk)
- `user_id` (uuid)
- `conversation_id` (uuid)
- `query` (text)
- `answer` (text)
- `citations` (jsonb)
- `latency_ms` (int)
- `cache_hit` (boolean)
- `created_at`

## Indexing Strategy

- vector index on `document_chunks.embedding` (pgvector)
- GIN index on `document_chunks.tsv`
- supporting indexes on job status/lock fields
- supporting indexes on cache expiry and version fields

## Ingestion Specification

Pipeline:

1. validate file metadata and checksum
2. persist file to storage
3. enqueue ingestion job
4. extract text + page metadata (with OCR fallback)
5. section-aware chunking (target 700 tokens, overlap 120)
6. generate contextual summary per chunk
7. embed `context + content`
8. upsert chunks and mark document ready

Reliability requirements:

- ingestion is idempotent (`sha256 + ingestion_version`)
- retry with bounded attempts
- dead-letter after max retries
- structured error capture in `ingestion_jobs.last_error`

## Retrieval Specification

1. normalize query
2. detect language
3. compute cache key
4. lookup cache
5. on miss, run hybrid retrieval:
- vector top-N
- keyword top-N
- fuse with Reciprocal Rank Fusion
6. rerank top 20
7. select best 5-8 chunks
8. write cache entry
9. generate answer constrained to retrieved evidence

## Answering and Citation Policy

- every factual claim must be traceable to returned citations
- citation fields are mandatory: `document_id`, `page_number`, `chunk_id`
- if confidence/evidence is below threshold, return insufficient-evidence response
- response streaming is required

## Cache and Versioning Policy

- default cache TTL: 24h
- cache key: `hash(normalized_query + language + retrieval_version + top_k)`
- retrieval version increments on re-ingestion or retrieval logic changes
- old cache entries are invalid after version bump

## Security and Access Control

- authenticated internal users only
- role model: access roles `admin` and `reader`; non-access account states `pending` (awaiting approval), `suspended`, `rejected`, stored in Supabase `app_metadata.role`
- RBAC enforced in API routes and UI actions
- rate limiting on query endpoint
- audit logs for privileged and data-impacting actions
- Supabase service-role credentials only via server env vars
- OpenAI credentials via server env default and optional per-user encrypted BYOK vault

## Observability and SLOs

Track:

- p50/p95 query latency
- cache hit ratio
- retrieval and reranker score distributions
- model error rate and timeout rate
- ingestion success/failure/retry rates

Targets:

- uncached query p95 latency: `< 15s`
- cached query p95 latency: `< 12s`
- concurrent users: `>= 50`

## Non-Functional Requirements

- robust failure handling for ingestion and model provider errors
- deterministic migration flow with rollback strategy
- CI quality gates enforced before deployment
- reproducible staging environment for release validation

## Release Criteria

System is release-ready only when:

- all CI gates pass
- evaluation thresholds in [`RAG_EVALUATION_FRAMEWORK.md`](/Users/hwitzthum/rag-system/docs/RAG_EVALUATION_FRAMEWORK.md) are met
- security and RBAC tests pass
- observability dashboards and alert rules are active

End of file
