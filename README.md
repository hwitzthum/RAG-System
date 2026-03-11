# RAG System

A production-ready multilingual Retrieval-Augmented Generation platform built with Next.js, Supabase, and OpenAI. Upload PDF documents, ask questions, and get grounded answers with citations — optionally augmented with live web research.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Architecture & Pipeline](#architecture--pipeline)
3. [Authentication](#authentication)
4. [User Guide](#user-guide)
5. [API Reference](#api-reference)
6. [Project Structure](#project-structure)
7. [Environment Variables](#environment-variables)
8. [Testing](#testing)
9. [Production Deployment](#production-deployment)

---

## Quick Start

### Prerequisites

- Node.js 20+
- A [Supabase](https://supabase.com) project (free tier works)
- An [OpenAI API key](https://platform.openai.com/api-keys)
- (Optional) A [Tavily API key](https://tavily.com) for web research

### 1. Install dependencies

```bash
npm install
```

> If your shell has `NODE_ENV=production`, run `NODE_ENV=development npm install` to include dev dependencies.

### 2. Configure environment

```bash
cp .env.example .env.local
```

Edit `.env.local` with your credentials:

```env
# Required — Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key

# Required — OpenAI
OPENAI_API_KEY=sk-...

# Optional — Web research
RAG_WEB_SEARCH_ENABLED=true
RAG_WEB_SEARCH_API_KEY=tvly-...
```

### 3. Set up the database

Apply the migrations to your Supabase project using the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
supabase link --project-ref your-project-ref
supabase db push
```

This creates all required tables (`documents`, `document_chunks`, `query_history`, `ingestion_jobs`, `rate_limit_buckets`, `metric_events`, etc.), stored procedures, and RLS policies.

### 4. Start the dev server

```bash
npm run dev
```

The app runs at [http://localhost:3000](http://localhost:3000) (or port 3001 if 3000 is in use).

### 5. Verify it works

```bash
curl http://localhost:3000/api/health
```

You should see `{"status":"ok", ...}` with current configuration values.

---

## Architecture & Pipeline

This section explains the concrete technical approaches used in the ingestion, retrieval, and answer generation pipelines, and why each design decision was made.

### Overview

```
┌─────────────┐    ┌──────────────────────────────────────────────┐
│  PDF Upload  │───▶│            Ingestion Pipeline                │
└─────────────┘    │  Extract → Chunk → Embed → Store             │
                   └──────────────────────────────────────────────┘
                                        │ document_chunks (pgvector)
                                        ▼
┌─────────────┐    ┌──────────────────────────────────────────────┐
│  User Query  │───▶│            Retrieval Pipeline                │
└─────────────┘    │  Embed → Hybrid Search → RRF → Rerank        │
                   │  → (Cross-Encoder) → (Contextual Grouping)   │
                   └──────────────────────────────────────────────┘
                                        │ ranked chunks
                                        ▼
                   ┌──────────────────────────────────────────────┐
                   │          Answer Generation                    │
                   │  Evidence Check → Prompt → LLM → SSE Stream  │
                   └──────────────────────────────────────────────┘
```

---

### 1. Ingestion Pipeline

When a PDF is uploaded it goes through a five-stage pipeline before it is queryable.

#### Stage 1 — Validation & Deduplication

Before any processing, the upload route validates the file:

- **PDF magic bytes check**: Confirms the file starts with `%PDF-` to reject non-PDF files even if they have a `.pdf` extension.
- **SHA-256 deduplication**: A checksum of the full file is computed. If an identical document was already uploaded, the upload is rejected with a clear message rather than creating a duplicate knowledge base entry.
- **Size limit**: Configurable maximum file size (default 50 MB) enforced server-side.

#### Stage 2 — Text Extraction

The background worker uses `pdfjs-dist` to extract text page-by-page, preserving page number metadata. Pages are then segmented into sections using heading-detection heuristics (regex patterns for common heading formats). This section boundary information flows into the chunker so that chunks do not silently straddle unrelated sections.

#### Stage 3 — Chunking with Overlap

Sections are split into overlapping chunks:

- **Target token size** (default ~512 tokens): Keeps chunks short enough to stay within embedding model context limits and avoids diluting embedding signal with off-topic content.
- **Overlap** (default ~100 tokens): Adjacent chunks share a window of text so that retrieval can find the full context for a sentence that sits at a chunk boundary.
- **Sentence-boundary respect**: The chunker avoids cutting mid-sentence, preserving linguistic coherence.

The combination of overlap and sentence-boundary awareness prevents information loss at chunk seams — a common failure mode in naive fixed-size chunking.

#### Stage 4 — Context Generation

Each chunk is augmented with a short context string stored separately from the raw content:

- **LLM-generated** (optional): OpenAI summarises what the surrounding section is about, producing a rich semantic label for the chunk.
- **Heuristic fallback**: `"{section_title} | page {n}: {first 200 chars}"` is used when LLM context generation is disabled.

This context field is prepended to the chunk text when building the retrieval prompt, helping the model understand a chunk even when it appears out of document context.

#### Stage 5 — Embedding & Storage

Each chunk is embedded with OpenAI `text-embedding-3-small` and stored in the `document_chunks` table alongside:

- The `embedding` column (pgvector, 1536 dimensions) for vector similarity search.
- A `tsv` column (PostgreSQL `tsvector`, auto-maintained) for full-text keyword search.
- `language`, `page_number`, `section_title`, and `chunk_index` for filtering and citation generation.

Storing both representations enables the hybrid retrieval approach described below.

---

### 2. Retrieval Pipeline

The retrieval pipeline is the heart of the system. Its goal is to return the most relevant chunks for a given query while maximising recall (finding everything relevant) and precision (ranking the best material first).

```
Query
  │
  ├─▶ Query Normalisation + Language Detection
  │
  ├─▶ Cache Lookup (SHA-256 key over query + language + topK + scope)
  │       └─ Hit: return cached result immediately
  │
  └─▶ (Cache Miss)
          │
          ├─▶ OpenAI Embedding (text-embedding-3-small)
          │
          ├─▶ Token Extraction
          │
          ├─▶ Parallel Search
          │       ├─ Vector Search   (pgvector cosine similarity)
          │       └─ Keyword Search  (PostgreSQL full-text search)
          │
          ├─▶ Cross-Language Fallback (if results < threshold)
          │
          ├─▶ Reciprocal Rank Fusion (RRF)
          │
          ├─▶ Lexical Reranking
          │
          ├─▶ Cross-Encoder Reranking  [opt-in]
          │
          ├─▶ Contextual Grouping      [opt-in]
          │
          └─▶ Cache Write → Return top-K chunks
```

#### Hybrid Search: Vector + Keyword

**Why hybrid?** Vector search captures semantic similarity (paraphrases, synonyms, conceptual relationships) but can miss exact terms — especially proper nouns, codes, or domain-specific abbreviations. Keyword search does the opposite: it excels at exact-match retrieval but fails on paraphrase. Running both in parallel and fusing results gives the best of both worlds.

- **Vector search** uses pgvector's cosine similarity index. The query embedding is compared against all chunk embeddings. The pool size is `max(topK × 4, RAG_RERANK_POOL_SIZE, 20)` — deliberately larger than the final `topK` to give the downstream rerankers enough candidates to work with.
- **Keyword search** uses PostgreSQL's built-in full-text search engine (`tsvector`/`tsquery`) with the `simple` dictionary. Query tokens are matched against the pre-computed `tsv` column.
- **Language filtering**: Both searches respect a detected or hinted language to avoid surfacing chunks in the wrong language. If a language-filtered search returns too few results, an automatic cross-language fallback repeats both searches without the language constraint and merges the combined pool.

#### Reciprocal Rank Fusion (RRF)

RRF is a rank-combination technique that is robust to score scale differences between retrieval systems. Each candidate chunk receives a score from both the vector and keyword result lists:

```
RRF score = 1 / (K + vector_rank) + 1 / (K + keyword_rank)
```

`K` (default 60) dampens the influence of top-ranked results and promotes candidates that appear in both lists. A chunk that ranks 3rd in vector search and 5th in keyword search will outscore a chunk that ranks 1st in only one source. This penalises single-source flukes and rewards consistent evidence.

#### Lexical Reranking

After RRF fusion, each chunk is scored with a weighted blend of three signals:

| Signal | Default weight | What it measures |
|--------|---------------|-----------------|
| Retrieval score | 0.60 | Normalised RRF / vector similarity |
| Lexical overlap | 0.35 | Fraction of query tokens present in chunk |
| Exact match | 0.05 | Boolean: chunk contains the full query string |

The lexical overlap signal provides a fast, interpretable cross-check against the embedding-based score. A chunk that semantically matches the query but contains none of its words is demoted; one that contains all query words but with weak embedding similarity is promoted slightly.

#### Cross-Encoder Reranking (optional, `RAG_CROSS_ENCODER_ENABLED`)

For the highest quality at higher cost, an LLM-based cross-encoder can re-evaluate the top-20 candidates. Unlike embedding similarity (which scores query and chunk independently), a cross-encoder sees the query and chunk together and returns a fine-grained relevance score (0.0–1.0). This late-stage reranking corrects cases where embedding vectors agree superficially but the content is not actually answerable.

A 3-second timeout with fallback to the previous rank ensures latency is bounded. Enabling this adds one LLM call per query (typically ~0.5–1.0 seconds).

#### Contextual Grouping (default enabled, `RAG_CONTEXTUAL_GROUPING_ENABLED`)

Documents often contain answers spread across adjacent chunks. Contextual grouping gives a score boost (+0.05 per neighbouring chunk, up to ±2 positions) to chunks that sit next to another high-ranking chunk from the same document. This promotes dense, coherent document sections over isolated snippets.

The intuition: if chunk 7 from document A is in the top-5, chunk 6 or 8 from the same document is likely to provide useful surrounding context, so they deserve a slight promotion over an equally-scored chunk from an unrelated document.

#### Result Caching

Retrieval results are cached in the `retrieval_cache` table using a SHA-256 key over:

- Normalised query text
- Detected language
- `RAG_RETRIEVAL_VERSION` (increment to invalidate the entire cache after re-ingestion)
- `topK`
- Document scope (specific document IDs or global)

Cache TTL defaults to 24 hours. A cache hit returns results immediately without any embedding or database search, making repeated or near-identical queries essentially free.

---

### 3. Answer Generation

#### Evidence Sufficiency Check

Before calling the LLM, the system checks whether the retrieved evidence is sufficient:

- At least `RAG_MIN_EVIDENCE_CHUNKS` chunks (default 2) must be present.
- At least one chunk must have a rerank score ≥ `RAG_MIN_RERANK_SCORE` (default 0.25).

If the evidence threshold is not met, the system returns a calibrated "insufficient evidence" response rather than hallucinating an answer. This is a deliberate design choice: it is better to say "I don't know" than to fabricate a confident but wrong answer.

#### Prompt Construction

Chunks are concatenated into the user prompt, each prefixed with a citation marker (`[Source N]`) and their context string. The system prompt instructs the model to answer only from the provided sources and to include citation markers in its response. These markers are parsed from the final answer to produce structured `citations` objects (documentId, page number, chunkId) returned to the client.

#### Web-Augmented Answers

When web research is enabled and the user activates it per-query, the system performs a Tavily web search in parallel with retrieval. Web sources with relevance ≥ 0.5 are appended to the prompt after the document chunks with their own citation markers. The model is instructed to prefer document sources but may draw on web content when document coverage is insufficient. Web sources are surfaced separately in the response so users can distinguish document-grounded from web-grounded claims.

#### Streaming (SSE)

The LLM response is streamed token-by-token via Server-Sent Events so the user sees output immediately. The stream emits four event types:

| Event | Content |
|-------|---------|
| `meta` | Retrieval metadata (cache hit, latency, chunk counts) |
| `token` | Individual answer tokens |
| `final` | Complete answer, citations, web sources, queryHistoryId |
| `done` | Stream complete signal |

---

## Authentication

The system uses **Supabase Auth** for all user management with a **pending-approval workflow** — new accounts require an administrator to grant access before they can use the app. Every page and API route is protected.

### User roles

| Role | Description | Permissions |
|------|-------------|-------------|
| **pending** | Default for new sign-ups | Can only see the pending-approval page; no API access |
| **reader** | Approved by an admin | Upload PDFs, query documents, download reports, manage BYOK keys |
| **admin** | Elevated access | Everything a reader can do, plus manage users at `/admin` |
| **suspended** | Revoked access | Redirected to login; all API calls return 403 |

Roles are stored in `app_metadata.role` on the Supabase user object and are enforced on every API request via JWT claims.

---

### Step 1 — Sign up

1. Open the app — you'll be redirected to `/login`
2. Click **Sign up** to go to `/signup`
3. Enter your email and a password (minimum 6 characters)
4. Click **Sign Up** — you'll see: *"Account created. An administrator will review your request."*
5. Check your email for a confirmation link and click it

> **First admin:** Set `ADMIN_EMAIL` in `.env.local` before the first sign-up. When a user registers with that email they are automatically promoted to `admin` instead of `pending`.

---

### Step 2 — Wait for approval (pending users)

After signing up, you land on the `/pending-approval` page:

```
Your account is pending approval by an administrator.
```

Two actions are available:

- **Check Status** — refreshes your session JWT. If an admin has approved your account, you are redirected to the workbench automatically.
- **Sign Out** — clears your session and returns to `/login`.

While `pending`, all API calls return `403 Forbidden`. You cannot access any workbench page.

---

### Step 3 — Admin approves the account

An administrator visits `/admin` and sees the user management table:

| Email | Role | Created | Actions |
|-------|------|---------|---------|
| user@example.com | pending | 2026-03-09 | **Approve** |

Clicking **Approve** changes the role from `pending` → `reader` via `PATCH /api/admin/users/:id`. The user's next **Check Status** click (or page reload after a new login) picks up the updated role from the refreshed JWT.

Available admin actions per user:

| Current role | Available actions |
|---|---|
| pending | Approve (→ reader) |
| reader | Promote to Admin / Suspend |
| admin | Demote to Reader *(disabled for self)* |
| suspended | Reactivate (→ reader) |

---

### Step 4 — Sign in

1. Go to `/login`
2. Enter your email and password
3. Click **Sign In**

The login flow:
1. The form calls `POST /api/auth/login` (rate-limited: 20 attempts per 5 min per IP + email)
2. If the account is `pending` → redirected to `/pending-approval`
3. If the account is `suspended` → error shown, no session created
4. If `reader` or `admin` → Supabase session cookies are set, redirected to `/`

Session cookies expire after **1 hour** and are transparently refreshed by the middleware on every request while you are active.

---

### Step 5 — Sign out

Click **Clear** in the Session Identity panel on the workbench, or call the API:

```bash
curl -X DELETE http://localhost:3000/api/auth/session \
  -H "Cookie: rag_access_token=<your-token>" \
  -H "X-CSRF-Token: <csrf-token>"
```

---

### Promoting the first admin (CLI)

If you did not set `ADMIN_EMAIL` before signing up, promote a user via the Supabase admin API:

```bash
curl -X PATCH https://your-project.supabase.co/auth/v1/admin/users/<user-id> \
  -H "apikey: your-service-role-key" \
  -H "Authorization: Bearer your-service-role-key" \
  -H "Content-Type: application/json" \
  -d '{"app_metadata": {"role": "admin"}}'
```

---

### API authentication

API routes accept two authentication methods:

#### 1. Session cookie (browser)

After signing in via the browser, Supabase sets session cookies automatically. All `fetch` calls from the workbench include a `X-CSRF-Token` header to prevent CSRF attacks. State-changing routes (`POST`, `PUT`, `DELETE`) require this header when using cookie auth.

#### 2. Bearer token (programmatic access)

Get a token from Supabase Auth:

```bash
curl -X POST https://your-project.supabase.co/auth/v1/token?grant_type=password \
  -H "apikey: your-anon-key" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"your-password"}'
# Returns: {"access_token":"eyJ...", "expires_in":3600, ...}
```

Use the `access_token` in API calls. Bearer token auth is **exempt from CSRF** (not a browser session):

```bash
# Query the knowledge base
curl -X POST http://localhost:3000/api/query \
  -H "Authorization: Bearer eyJ..." \
  -H "Content-Type: application/json" \
  -d '{"query": "What does the document say about X?"}'

# Upload a document
curl -X POST http://localhost:3000/api/upload \
  -H "Authorization: Bearer eyJ..." \
  -F "file=@/path/to/document.pdf"

# Batch upload
curl -X POST http://localhost:3000/api/upload/batch \
  -H "Authorization: Bearer eyJ..." \
  -F "files=@/path/to/doc1.pdf" \
  -F "files=@/path/to/doc2.pdf"
```

#### Rate limits

| Endpoint | Limit |
|---|---|
| `POST /api/auth/login` | 20 attempts per 5 min per IP + email |
| `POST /api/auth/signup` | 3 sign-ups per hour per IP |

Exceeding the limit returns `429 Too Many Requests`.

---

## User Guide

This section walks through every feature of the application as an approved user.

### Accessing the workbench

After signing in with an approved account, you land on the **RAG Workbench** — a single-page interface divided into panels. All interactions happen here without page reloads.

---

### Uploading documents

Before you can query anything, you need to upload at least one PDF document.

#### Single upload

1. Find the **Ingestion Desk** panel on the workbench.
2. Click **Choose File** and select a PDF from your computer.
3. Optionally enter a title for the document (defaults to the filename).
4. Click **Upload**.
5. The document appears in the document list with a status badge:
   - **queued** — received, waiting for the background worker
   - **processing** — worker is extracting, chunking, and embedding
   - **ready** — fully ingested and queryable
   - **failed** — ingestion error (a **Retry** button appears)

Status updates automatically while the page is open.

#### Batch upload

1. Use the **Batch Upload** file input to select up to 10 PDFs at once.
2. Click **Upload All**.
3. Each file gets its own row with individual status tracking. Files are uploaded sequentially and processed in the background.

**Tips:**
- Only PDF files are accepted. Non-PDF files are rejected at upload time.
- Uploading the same PDF twice is detected by checksum and rejected with a helpful message.
- File size limit: 50 MB per file.
- If ingestion fails, click **Retry** to re-queue the document without re-uploading it.

---

### Asking questions

Once at least one document is in **ready** state, you can query the knowledge base.

1. Type your question in the query text area at the top of the workbench.
2. Configure optional parameters (see below).
3. Click **Send Query** or press `Enter`.
4. The answer streams in word-by-word, followed by numbered citations.

#### Query options

| Option | Description |
|--------|-------------|
| **Document scope** | Restrict the search to a single document, or query all documents at once (default). |
| **Web Research** | When checked, the system also searches the web via Tavily and incorporates relevant results alongside document evidence. |
| **Language hint** | Manually specify the language of your query (EN/DE/FR/IT/ES) to override automatic detection. |
| **Top K** | How many source chunks the retrieval pipeline should include (1–20, default 8). Higher values may improve recall on complex questions but increase LLM cost. |

#### Reading the answer

- **Answer text**: Grounded in your uploaded documents. Citation markers like `[Source 1]` appear inline.
- **Citations panel**: Lists the exact page numbers and document names for each cited source. Click a citation to inspect the raw chunk text.
- **Web sources** (if web research was enabled): Displayed below the answer with URLs and relevance snippets.
- **Cache indicator**: A small badge shows whether this query result was served from cache (instant) or freshly computed.
- **Retrieval metadata**: Expandable panel showing counts of vector/keyword/fused/reranked candidates and latency.

If the system cannot find sufficient evidence in your documents to answer the question, it will say so rather than guessing. This is intentional — add more relevant documents or refine your query.

---

### Downloading reports

After any query completes, two report buttons appear on that query turn:

- **Download DOCX** — a formatted Word document containing the query, answer, citations, and raw chunk text.
- **Download PDF** — the same content as a PDF.

Reports are generated on-demand server-side and downloaded directly to your browser. They are useful for sharing results with colleagues who do not have access to the application.

---

### Using query history

Previous queries are saved and accessible from the **Query History** panel:

1. Open the history panel.
2. Click any past query to reload it into the current turn view.
3. Report buttons are available for historical queries as well.

---

### Bring Your Own OpenAI Key (BYOK)

If you have your own OpenAI API key, you can store it in the encrypted vault so your queries use your key rather than the shared server key:

1. Open the **OpenAI Key** panel on the workbench.
2. Paste your key (starts with `sk-`).
3. Click **Save**.
4. A status indicator confirms whether the key is valid.
5. To remove it, click **Delete**.

Your key is encrypted server-side before storage and is never accessible from the browser after saving.

---

### Admin — managing users

If your account has the `admin` role, an **Admin** link appears in the navigation.

The admin panel shows a table of all registered users with their current roles. Available actions per user:

| Current role | What you can do |
|---|---|
| pending | **Approve** → promotes to reader |
| reader | **Promote to Admin** or **Suspend** |
| admin | **Demote to Reader** (not available for your own account) |
| suspended | **Reactivate** → restores reader access |

Changes take effect immediately. The affected user will see the updated role on their next page load or **Check Status** action.

---

## API Reference

All endpoints require authentication unless noted.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/health` | No | Health check with config summary |
| `POST` | `/api/auth/login` | No | Rate-limited login; checks pending/suspended |
| `POST` | `/api/auth/signup` | No | Rate-limited sign-up; auto-promotes admin email |
| `POST` | `/api/auth/session` | No | Create session from access token |
| `GET` | `/api/auth/session` | Cookie | Get current session user |
| `DELETE` | `/api/auth/session` | Cookie + CSRF | Clear session |
| `POST` | `/api/query` | Yes + CSRF | Execute RAG query (SSE stream) |
| `GET` | `/api/query-history` | Yes | List past queries |
| `POST` | `/api/upload` | Yes + CSRF | Upload a PDF document |
| `GET` | `/api/upload/:id` | Yes | Get upload/ingestion status |
| `POST` | `/api/upload/batch` | Yes + CSRF | Batch upload PDFs |
| `POST` | `/api/reports` | Yes + CSRF | Generate DOCX/PDF report |
| `GET/PUT/DELETE` | `/api/byok/openai` | Yes + CSRF | Manage OpenAI BYOK key |
| `GET` | `/api/admin/users` | Admin | List all users |
| `PATCH` | `/api/admin/users/:id` | Admin + CSRF | Update user role |
| `POST` | `/api/internal/observability/metrics` | Bearer | Ingest metric events |

> **CSRF note:** Routes marked `+ CSRF` require an `X-CSRF-Token` header when called with cookie-based auth. Bearer token auth skips CSRF validation. The CSRF token is set as a cookie (`csrf_token`) on login and must be read client-side and sent as a header.

### Query request

```json
{
  "query": "What are the key findings?",
  "topK": 5,
  "documentId": "optional-uuid-to-scope-search",
  "languageHint": "EN",
  "enableWebResearch": true
}
```

### Query response (SSE)

The response is a stream of Server-Sent Events:

- `meta` — retrieval metadata (cache hit, latency, chunk IDs)
- `token` — individual answer tokens (for streaming display)
- `final` — complete answer, citations, web sources, queryHistoryId
- `done` — stream complete

---

## Project Structure

```
app/                  Next.js App Router pages and API routes
  (auth)/             Login, signup, reset-password pages
  api/                API route handlers
components/           React components (workbench UI)
lib/
  answering/          Answer generation (grounded + web-augmented)
  auth/               Authentication (JWT verification, session, RBAC)
  config/             Environment variable validation (Zod)
  contracts/          TypeScript types for API and retrieval
  ingestion/          PDF upload and ingestion pipeline
  observability/      Audit logging and metrics emission
  providers/          OpenAI provider abstraction and BYOK vault
  reports/            DOCX and PDF report generation
  retrieval/          Hybrid retrieval, reranking, cross-encoder, caching
  runtime/            Runtime secrets management
  security/           Rate limiting (shared + in-memory) and IP extraction
  supabase/           Supabase clients (admin, browser, server)
  web-research/       Tavily web search integration
supabase/migrations/  Database schema migrations
tests/                Unit and E2E tests
```

---

## Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes | Supabase anonymous/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Same as SUPABASE_URL (client-side) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Same as SUPABASE_ANON_KEY (client-side) |
| `OPENAI_API_KEY` | Yes | OpenAI API key for embeddings and LLM |
| `RAG_CROSS_ENCODER_ENABLED` | No | Enable LLM-based cross-encoder reranking (default: false) |
| `RAG_CONTEXTUAL_GROUPING_ENABLED` | No | Boost adjacent chunks from same document (default: true) |
| `RAG_WEB_SEARCH_ENABLED` | No | Enable web research via Tavily (default: false) |
| `RAG_WEB_SEARCH_API_KEY` | No | Tavily API key (required if web search enabled) |
| `ADMIN_EMAIL` | No | Email auto-promoted to admin on first sign-up |
| `AUTH_DEV_INSECURE_BYPASS` | No | Skip auth in development (default: false) |
| `OPENAI_BYOK_VAULT_KEY` | Prod | Base64-encoded 32-byte key for BYOK encryption |
| `CRON_SECRET` | Prod* | Required if `INGESTION_RUNTIME_MODE=vercel` |

---

## Testing

```bash
# Type checking
npm run typecheck

# Unit tests (32 tests)
npx tsx --test tests/*.test.ts

# E2E tests (43 tests — requires dev server running)
npm run dev &
npx playwright test

# Lint
npm run lint

# All checks
npm run check
```

---

## Production Deployment

### Build

```bash
npm run build
npm start
```

### Production requirements

- `AUTH_DEV_INSECURE_BYPASS` must be `false`
- `OPENAI_BYOK_VAULT_KEY` must be set (32-byte base64 encryption key)
- `CRON_SECRET` must be set if using `INGESTION_RUNTIME_MODE=vercel`

### Validation

```bash
npm run release:readiness:precutover    # Dry-run all checks
npm run release:matrix:precutover       # Full pre-deployment matrix
```