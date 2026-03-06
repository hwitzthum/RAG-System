# VERCEL_HOSTING_SETUP_GUIDE_FOR_DUMMIES.md

Version: 1.0  
Date: 2026-03-06  
Last verified against Vercel docs: 2026-03-06

## Who this is for

You want to host this app on Vercel and you want every step spelled out.

## What gets deployed to Vercel in this project

- Deployed to Vercel:
  - Next.js frontend (`app/`)
  - Next.js API routes (`app/api/*`)
- Not deployed to Vercel:
  - Python ingestion worker (`worker/`)

Important:

- You still need to run the worker separately (for example on Cloud Run, Railway, Fly.io, or another container host).
- If worker is not running, uploads will queue but ingestion will not complete.

---

## Step 0: Preconditions (do this first)

1. You have:
   - a Vercel account
   - a GitHub/GitLab/Bitbucket account
   - a Supabase project already configured
2. Your code is in a Git repository and pushed to remote (GitHub etc.).
3. You are in this folder:

```bash
cd /Users/hwitzthum/rag-system
```

---

## Step 1: Install Vercel CLI (optional but recommended)

Vercel supports CLI and Dashboard workflows.

Install CLI globally:

```bash
npm i -g vercel
```

Or use it with `npx` without global install:

```bash
npx vercel --help
```

Login in CLI:

```bash
vercel login
```

---

## Step 2: Import this repository into Vercel (Dashboard path)

1. Open Vercel dashboard and click **Add New > Project**.
2. Connect your Git provider (GitHub/GitLab/Bitbucket) if prompted.
3. Select the repository containing `rag-system`.
4. In project settings before deploy:
   - Framework Preset: **Next.js** (normally auto-detected)
   - Root Directory: repo root (`rag-system`)
   - Build/Output commands: keep defaults unless you have a custom override
5. Do not click Deploy yet. First add environment variables (next step).

---

## Step 3: Add required environment variables in Vercel

Open: **Project > Settings > Environment Variables**

Add these variables for at least `Production` and `Preview`:

- `NODE_ENV=production`
- `NEXT_PUBLIC_APP_NAME=RAG System`
- `SUPABASE_URL=https://<project-ref>.supabase.co`
- `SUPABASE_ANON_KEY=<your-anon-key>`
- `SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>`
- `SUPABASE_JWT_SECRET=<your-jwt-secret>` (or keep `AUTH_JWKS_URL` configured)
- `AUTH_JWKS_URL=https://<project-ref>.supabase.co/auth/v1/keys`
- `AUTH_DEV_INSECURE_BYPASS=false`
- `AUTH_RATE_LIMIT_WINDOW_SECONDS=60`
- `AUTH_RATE_LIMIT_MAX_REQUESTS=30`
- `OPENAI_API_KEY=<your-openai-key>`
- `OPENAI_BYOK_VAULT_KEY=<base64-encoded-32-byte-key>`
- `OPENAI_BYOK_VAULT_KEY_VERSION=1`
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
- `RAG_STORAGE_BUCKET=documents`

Notes:

- `SUPABASE_SERVICE_ROLE_KEY` is sensitive. Keep it only in server environment variables.
- `OPENAI_BYOK_VAULT_KEY` must be secret and server-only. Generate one with `openssl rand -base64 32`.
- In Next.js, only variables starting with `NEXT_PUBLIC_` are exposed to browser.

---

## Step 4: Deploy the project

If you are in the import flow:

1. Click **Deploy**.
2. Wait until deployment completes.
3. Open the generated `*.vercel.app` URL.

If you prefer CLI:

```bash
vercel link
vercel
vercel --prod
```

---

## Step 5: Validate this app after deployment

Check these endpoints/features:

1. Health endpoint:
   - `https://<your-app>.vercel.app/api/health`
2. Auth session endpoint exists:
   - `POST /api/auth/session`
3. Upload endpoint exists:
   - `POST /api/upload`
4. Query endpoint exists:
   - `POST /api/query`

Then test full flow:

1. Create a valid token-backed session in UI.
2. Upload a PDF as admin.
3. Confirm ingestion status progresses (worker must be running externally).
4. Run a query and confirm citations are returned.

---

## Step 6: Connect local repo to the same Vercel project (for scripts)

From repo root:

```bash
vercel link
vercel env pull .env.vercel
```

Then fill local staging env if needed:

```bash
cp .env.staging.example .env.staging
```

After `vercel link`, open `.vercel/project.json` and copy:

- `orgId` -> `VERCEL_ORG_ID`
- `projectId` -> `VERCEL_PROJECT_ID`

Then paste them into `.env.staging`.

And run validations:

```bash
npm run infra:check-env:staging
npm run check
npm run test:security
```

---

## Step 7: Configure production branch and preview behavior

In Vercel project settings:

1. Set **Production Branch** (usually `main`).
2. Keep Preview Deployments enabled for pull requests/feature branches.

Typical behavior:

- Push to production branch -> production deployment
- Push/PR to other branches -> preview deployment

---

## Step 8: Add a custom domain (optional but recommended)

1. Open **Project > Settings > Domains**
2. Add your domain (for example `app.yourcompany.com`)
3. Follow DNS instructions exactly (A/CNAME records shown by Vercel)
4. Wait for DNS verification
5. Re-test app endpoints on custom domain

---

## Step 9: Monitor logs and runtime issues

Use dashboard:

- **Deployments** for build logs
- **Functions** for serverless function logs
- **Observability/Logs** as needed

Or CLI:

```bash
vercel logs <deployment-url>
```

---

## Step 10: Roll back safely if production breaks

Dashboard method:

1. Open **Deployments**
2. Select last known good deployment
3. Promote it back to Production

After rollback:

1. Verify `/api/health`
2. Verify auth + query flow
3. Open incident note and fix root cause before redeploy

---

## Step 11: Production checklist for this project

Before go-live:

1. Vercel deployment is green
2. All required env vars are configured in Production
3. Supabase project is reachable from deployment
4. External worker is running and healthy
5. `npm run eval:benchmark` passes in staging
6. `npm run obs:validate` passes
7. `npm run release:readiness` passes

---

## Recommended Vercel plan for this app

Practical recommendation:

1. Start on **Pro** for production workloads, team collaboration, and predictable scaling.
2. Hobby is okay for quick testing but is usually too limited for production RAG workloads.
3. Move to Enterprise only if compliance/governance requirements demand it.

Always verify current pricing/features on the live pricing page:

- [https://vercel.com/pricing](https://vercel.com/pricing)

---

## Official Vercel sources used

- Vercel docs home: [https://vercel.com/docs](https://vercel.com/docs)
- Deploying with Vercel / getting started: [https://vercel.com/docs/deployments](https://vercel.com/docs/deployments)
- Framework docs (Next.js): [https://vercel.com/docs/frameworks/nextjs](https://vercel.com/docs/frameworks/nextjs)
- Environment variables: [https://vercel.com/docs/environment-variables](https://vercel.com/docs/environment-variables)
- Custom domains: [https://vercel.com/docs/domains](https://vercel.com/docs/domains)
- Vercel CLI: [https://vercel.com/docs/cli](https://vercel.com/docs/cli)
- Vercel CLI `link`: [https://vercel.com/docs/cli/link](https://vercel.com/docs/cli/link)
- Vercel CLI `env`: [https://vercel.com/docs/cli/env](https://vercel.com/docs/cli/env)
- Vercel CLI `logs`: [https://vercel.com/docs/cli/logs](https://vercel.com/docs/cli/logs)
- Vercel pricing: [https://vercel.com/pricing](https://vercel.com/pricing)
