# RAG System

A production-ready multilingual Retrieval-Augmented Generation platform built with Next.js, Supabase, and OpenAI. Upload PDF documents, ask questions, and get grounded answers with citations — optionally augmented with live web research.

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

## Authentication

The system uses **Supabase Auth** for all user management. Every page and API route is protected — unauthenticated users are redirected to `/login`.

### Creating an account

1. Open the app in your browser — you'll be redirected to `/login`
2. Click **Sign up** to go to `/signup`
3. Enter your email and a password (minimum 6 characters)
4. Check your email for a confirmation link and click it
5. Return to `/login` and sign in with your credentials

New users are automatically assigned the **reader** role (via a database trigger), which grants access to:
- Uploading PDF documents
- Querying the knowledge base
- Downloading reports
- Managing personal OpenAI BYOK keys

### Signing in

1. Go to `/login`
2. Enter your email and password
3. Click **Sign In**

On successful login, Supabase sets session cookies automatically. The middleware refreshes these cookies on every request — you stay signed in until you explicitly sign out or the session expires (8 hours).

### Signing out

Click **Clear** in the Session Identity panel on the workbench, or delete your session via the API:

```bash
curl -X DELETE http://localhost:3000/api/auth/session
```

### Roles

| Role | Permissions |
|------|-------------|
| **reader** | Upload PDFs, query documents, download reports, manage BYOK keys |
| **admin** | Everything a reader can do (admin-specific features reserved for future use) |

Roles are stored in `app_metadata.role` on the Supabase user object. To promote a user to admin, update their metadata via the Supabase dashboard or admin API.

### API authentication

API routes accept authentication via:

1. **Session cookie** (automatic after browser login)
2. **Bearer token** in the `Authorization` header (for programmatic access)

To get a Bearer token programmatically:

```bash
curl -X POST https://your-project.supabase.co/auth/v1/token?grant_type=password \
  -H "apikey: your-anon-key" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"your-password"}'
```

Use the returned `access_token` in API calls:

```bash
curl -X POST http://localhost:3000/api/query \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"query": "What does the document say about X?"}'
```

---

## Using the Workbench

After signing in, you land on the **RAG Workbench** — the main interface with these sections:

### Querying documents

1. Type a question in the query textarea
2. (Optional) Check **Web Research** to augment answers with live web results
3. Click **Send Query**
4. The answer streams in via SSE with citations linked to source documents

### Uploading documents

**Single upload:** Select a PDF in the Ingestion Desk panel. It uploads immediately, and the system tracks ingestion status (queued → processing → ready).

**Batch upload:** Use the "Batch Upload" file input to select multiple PDFs at once. Each file uploads sequentially with individual status badges (pending/uploading/queued/failed).

### Downloading reports

After a query completes, **Download DOCX** and **Download PDF** buttons appear on the turn. These generate a formatted report containing the query, answer, citations, and source chunk content.

### OpenAI BYOK (Bring Your Own Key)

Users can store their own OpenAI API key in the encrypted vault. The key is used for their queries instead of the server-wide key. Keys are encrypted server-side and never stored in the browser.

---

## API Reference

All endpoints require authentication unless noted.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/health` | No | Health check with config summary |
| `POST` | `/api/auth/session` | No | Create session from access token |
| `GET` | `/api/auth/session` | Cookie | Get current session user |
| `DELETE` | `/api/auth/session` | Cookie | Clear session |
| `POST` | `/api/query` | Yes | Execute RAG query (SSE stream) |
| `GET` | `/api/query-history` | Yes | List past queries |
| `POST` | `/api/upload` | Yes | Upload a PDF document |
| `GET` | `/api/upload/:id` | Yes | Get upload/ingestion status |
| `POST` | `/api/upload/batch` | Yes | Batch upload PDFs |
| `POST` | `/api/reports` | Yes | Generate DOCX/PDF report |
| `GET/PUT/DELETE` | `/api/byok/openai` | Yes | Manage OpenAI BYOK key |
| `POST` | `/api/internal/observability/metrics` | Bearer | Ingest metric events |

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
| `AUTH_DEV_INSECURE_BYPASS` | No | Skip auth in development (default: false) |

---

## Testing

```bash
# Type checking
npm run typecheck

# Unit tests (32 tests)
npx tsx --test tests/*.test.ts

# E2E tests (28 tests — requires dev server running)
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
