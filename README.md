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
