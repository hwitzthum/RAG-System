# SUPABASE_SETUP_GUIDE_FOR_DUMMIES.md

Version: 1.0  
Date: 2026-03-06  
Last verified against Supabase docs: 2026-03-06

## Who this is for

This guide assumes you know nothing about Supabase yet.  
Follow it in order, click by click, command by command.

## Goal

At the end, your `rag-system` app will have:

- a real Supabase project
- correct environment variables in this repo
- migrations applied (`pgvector`, tables, bucket, policies)
- at least one login user you can use to create an app session

---

## Step 0: Open the correct folder

```bash
cd /Users/hwitzthum/rag-system
```

---

## Step 1: Create a Supabase project

1. Open [database.new](https://database.new).
2. Create/select an organization.
3. Create a new project (name, database password, region).
4. Wait until project provisioning completes.

Supabase quickstart explicitly points to `database.new` for project creation.

---

## Step 2: Collect the 4 values you absolutely need

You need these values from Supabase Dashboard:

1. `SUPABASE_URL`
2. `SUPABASE_ANON_KEY`
3. `SUPABASE_SERVICE_ROLE_KEY`
4. `SUPABASE_PROJECT_REF`

How to get them:

1. In your Supabase project, open **Connect** dialog.
2. Copy project URL + keys from Connect/API Keys.
3. If you need legacy keys for this app:
   - `anon` for client-side
   - `service_role` for server-side
4. Get `project_ref` from project URL:
   - `https://supabase.com/dashboard/project/<project-ref>`

Important:

- Never expose `service_role` in browser/client code.

---

## Step 3: Fill env files in this repo

Copy templates:

```bash
cp .env.example .env.local
cp .env.staging.example .env.staging
cp worker/.env.example worker/.env
```

Now open and replace placeholders in:

- `/Users/hwitzthum/rag-system/.env.local`
- `/Users/hwitzthum/rag-system/.env.staging`
- `/Users/hwitzthum/rag-system/worker/.env`

Set at least:

- `SUPABASE_URL=https://<project-ref>.supabase.co`
- `SUPABASE_ANON_KEY=<anon-key>`
- `SUPABASE_SERVICE_ROLE_KEY=<service-role-key>`
- `SUPABASE_PROJECT_REF=<project-ref>`
- `SUPABASE_DB_PASSWORD=<database-password-you-chose>`
- `AUTH_JWKS_URL=https://<project-ref>.supabase.co/auth/v1/keys`
- `RAG_STORAGE_BUCKET=documents`
- `OPENAI_BYOK_VAULT_KEY=<base64-encoded-32-byte-key>` (app/staging env files)
- `OPENAI_BYOK_VAULT_KEY_VERSION=1` (app/staging env files)

Also set `OPENAI_API_KEY` in both app + worker env files.

You can generate a vault key with:

```bash
openssl rand -base64 32
```

---

## Step 4: Install and verify Supabase CLI

Supabase docs support using `npx` directly.

```bash
npx supabase --help
```

Optional local install:

```bash
npm install supabase --save-dev
```

Then login:

```bash
npx supabase login
```

---

## Step 5: Link this repo to your remote Supabase project

```bash
npx supabase link --project-ref <project-ref>
```

If prompted, enter your DB password (`SUPABASE_DB_PASSWORD`).

---

## Step 6: Push this project schema/config to Supabase

This repo already contains migrations:

- `supabase/migrations/202603060001_phase2_bootstrap.sql`
- `supabase/migrations/202603060002_phase3_core_schema.sql`
- `supabase/migrations/202603060003_phase7_retrieval_rpc.sql`

Apply them:

```bash
npx supabase db push
```

What this sets up for you:

- `vector` extension (`pgvector`)
- `documents` private storage bucket (50MB pdf limit)
- storage policies for `admin` / `reader`
- all core RAG tables and indexes
- retrieval RPC function

---

## Step 7: Validate configuration before running app

```bash
npm run infra:check-env:web
npm run infra:check-env:worker
npm run infra:check-env:staging
npm run db:validate:migrations
```

If one command fails, fix that error first, then rerun.

---

## Step 8: Verify Supabase objects in Dashboard (no guessing)

In Supabase Dashboard, check:

1. **Database > Extensions**: `vector` is enabled.
2. **Storage > Buckets**: `documents` exists and is private.
3. **Database > Tables**: `documents`, `document_chunks`, `retrieval_cache`, `ingestion_jobs`, `query_history` exist.

---

## Step 9: Create one app user and get an access token

This app expects JWT role claim `admin` or `reader`.

### 9.1 Create user (server-side admin call)

Run:

```bash
SUPABASE_URL="https://<project-ref>.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="<service-role-key>" \
SUPABASE_ANON_KEY="<anon-key>" \
node <<'EOF'
const { createClient } = require("@supabase/supabase-js");

const url = process.env.SUPABASE_URL;
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anon = process.env.SUPABASE_ANON_KEY;

const email = "admin@example.com";
const password = "ChangeMe-Strong-Password-123!";

const admin = createClient(url, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });
const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

(async () => {
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: "admin" }
  });
  if (created.error) {
    console.error("createUser error:", created.error.message);
  }

  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) {
    console.error("signIn error:", signedIn.error.message);
    process.exit(1);
  }

  console.log("\nACCESS TOKEN (copy this):\n");
  console.log(signedIn.data.session.access_token);
})();
EOF
```

### 9.2 Create app session in UI

1. Start app:
```bash
npm run dev
```
2. Open `http://localhost:3000`
3. Paste the token into the token input field
4. Click **Create Session**

If you get `Token missing required claims`, sign in again after ensuring user role claim exists (`admin` or `reader`).

---

## Step 10: Start worker

```bash
cd /Users/hwitzthum/rag-system/worker
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
cp .env.example .env  # skip if already filled
python -m rag_worker.main
```

---

## Step 11: Smoke test end-to-end

1. In UI, upload a PDF as an authenticated user (`reader` or `admin`).
2. Wait for ingestion status to become ready.
3. Ask a query.
4. Confirm answer + citations appear.

Optional validations:

```bash
npm run check
npm run test:security
npm run test:worker
```

---

## Pricing: Which Supabase plan is best for this app?

Your app profile:

- multilingual RAG
- vector search (`pgvector`)
- storage for ~350 PDFs
- at least staging + production

### Plan comparison (practical for this app)

1. **Free plan**
- Good only for experimentation.
- Limits include:
  - 2 free projects total
  - DB size 500 MB/project
  - Storage size 1 GB
  - Realtime peak connections 200
- Free projects can be paused.
- Conclusion: not suitable for production RAG with staging + production.

2. **Pro plan (recommended starting point)**
- Good default for this application.
- Included quotas (Pro/Team class):
  - DB size 8 GB/project
  - Storage 100 GB
  - Egress 250 GB
  - Realtime peak connections 500
- Docs invoice example shows a **Pro Plan line item = $25** plus per-project compute.
- Compute baseline example: Micro ~`$10/month` per running project.
- Conclusion: best balance for this app now.

3. **Team plan**
- Choose this when you need stronger team governance/collaboration and higher operational capacity.
- Realtime limits jump up to 10,000 concurrent connections.
- Fixed Team subscription fee is shown on Supabase pricing page (check live page for exact current amount).
- Conclusion: use Team when Pro is operationally too small.

4. **Enterprise**
- Only if you need custom limits/compliance/support model.

### My recommendation for your current app

Use **Pro** first, with:

- 1 staging project + 1 production project
- monitor usage for 2-4 weeks
- upgrade to Team only if team/realtime/governance needs demand it

---

## Troubleshooting (fast)

1. `Missing SUPABASE_URL / ANON / SERVICE_ROLE`  
Fix `.env.local`, `.env.staging`, `worker/.env`, then rerun env checks.

2. `Invalid access token` in app session  
Regenerate token using Step 9. Use the same project URL/keys as app env.

3. `Unauthorized` on query  
Token role claim must be `admin` or `reader`.

4. `supabase db push` fails  
Run `npx supabase link --project-ref <project-ref>` again and verify DB password.

---

## Official Supabase sources used

- Supabase docs home: [https://supabase.com/docs](https://supabase.com/docs)
- Next.js quickstart (project creation + env/connect): [https://supabase.com/docs/guides/getting-started/quickstarts/nextjs](https://supabase.com/docs/guides/getting-started/quickstarts/nextjs)
- API keys (where to find keys, key safety): [https://supabase.com/docs/guides/api/api-keys](https://supabase.com/docs/guides/api/api-keys)
- Local development + link/push flow: [https://supabase.com/docs/guides/local-development/overview](https://supabase.com/docs/guides/local-development/overview)
- CLI getting started: [https://supabase.com/docs/guides/local-development/cli/getting-started](https://supabase.com/docs/guides/local-development/cli/getting-started)
- Creating storage buckets: [https://supabase.com/docs/guides/storage/buckets/creating-buckets](https://supabase.com/docs/guides/storage/buckets/creating-buckets)
- Billing and quotas: [https://supabase.com/docs/guides/platform/billing-on-supabase](https://supabase.com/docs/guides/platform/billing-on-supabase)
- Live pricing page: [https://supabase.com/pricing](https://supabase.com/pricing)
- Storage pricing: [https://supabase.com/docs/guides/storage/pricing](https://supabase.com/docs/guides/storage/pricing)
- Realtime limits by plan: [https://supabase.com/docs/guides/realtime/limits](https://supabase.com/docs/guides/realtime/limits)
- Compute and disk pricing: [https://supabase.com/docs/guides/platform/compute-and-disk](https://supabase.com/docs/guides/platform/compute-and-disk)
- Disk IOPS pricing + invoice example (includes Pro line item): [https://supabase.com/docs/guides/platform/manage-your-usage/disk-iops](https://supabase.com/docs/guides/platform/manage-your-usage/disk-iops)
- pgvector extension guide: [https://supabase.com/docs/guides/database/extensions/pgvector](https://supabase.com/docs/guides/database/extensions/pgvector)
- JS auth sign in with password: [https://supabase.com/docs/reference/javascript/auth-signinwithpassword](https://supabase.com/docs/reference/javascript/auth-signinwithpassword)
- JS admin create user: [https://supabase.com/docs/reference/javascript/auth-admin-createuser](https://supabase.com/docs/reference/javascript/auth-admin-createuser)
