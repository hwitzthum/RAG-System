# OTHER_API_KEYS_SETUP_GUIDE_FOR_DUMMIES.md

Version: 1.0  
Date: 2026-03-06  
Last verified against web docs: 2026-03-06

## What this guide covers

You already have:

- Supabase setup guide
- Vercel hosting guide

This guide covers the **other required API keys** for this app.

## Short answer (important)

For this repository, the only additional external API key you must set is:

- `OPENAI_API_KEY`

Why:

- The app uses OpenAI for embeddings and answer generation.
- The env validator requires `OPENAI_API_KEY` for web/staging.

---

## Step 1: Create/Open your OpenAI API account

1. Open the OpenAI Platform: [https://platform.openai.com](https://platform.openai.com)
2. Sign in (or create account).
3. Make sure you are in the correct organization/project in the top-left selector.

OpenAI project docs indicate API keys are managed at project level.

---

## Step 2: Set up billing first (so requests do not fail)

1. Open billing overview in OpenAI Platform settings.
2. Add payment details.
3. Add prepaid credits.

From OpenAI Help:

- minimum prepaid purchase is `$5`
- credits expire after 1 year and are non-refundable

---

## Step 3: Create your API key

1. Open API Keys page: [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Click **Create new secret key**.
3. Copy the key immediately and store it in a password manager.

OpenAI quickstart and help center explicitly state:

- create key in dashboard/API key page
- use `OPENAI_API_KEY` environment variable

---

## Step 4: Choose key permissions (simple + safe)

OpenAI supports key permission modes:

- `All`
- `Restricted`
- `Read Only`

For this app, easiest working option:

1. Start with `All` for first successful setup.
2. After setup works, switch to `Restricted` and allow only required endpoints.

This app currently calls:

- `/v1/embeddings` (for retrieval embeddings)
- `/v1/chat/completions` (for final answers)

So restricted key must allow those endpoints.

---

## Step 5: Put OPENAI key into all required environments

### 5.1 Local web app

Edit:

- `/Users/hwitzthum/rag-system/.env.local`

Set:

```env
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxx
```

### 5.2 Local ingestion worker

Edit:

- `/Users/hwitzthum/rag-system/.env.local`

Set:

```env
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxx
```

### 5.3 Staging env file

Edit:

- `/Users/hwitzthum/rag-system/.env.staging`

Set:

```env
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxx
```

### 5.4 Vercel project env

In Vercel dashboard:

1. Project -> Settings -> Environment Variables
2. Add `OPENAI_API_KEY`
3. Add for both:
   - `Production`
   - `Preview`

### 5.5 Local worker process

The local ingestion worker reads the same `.env.local` file as the app, so no separate worker env file is required.

---

## Step 6: Validate key works before running full app

From terminal:

```bash
export OPENAI_API_KEY="sk-xxxxxxxxxxxxxxxx"

curl https://api.openai.com/v1/embeddings \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"text-embedding-3-small","input":"test connectivity"}'
```

If this returns JSON with embedding data, key is valid.

---

## Step 7: Validate this repo configuration

Run:

```bash
cd /Users/hwitzthum/rag-system
npm run infra:check-env:web
npm run infra:check-env:staging
```

If these pass, key wiring is correct for local + staging contract checks.

---

## Step 8: Confirm end-to-end usage

1. Start app:
```bash
npm run dev
```
2. Start worker (if testing ingestion locally).
3. Run a query in UI.
4. Confirm no OpenAI auth error in logs.

---

## Common errors and exact fixes

1. Error: `Invalid environment configuration ... OPENAI_API_KEY ... undefined`  
Fix: add `OPENAI_API_KEY` to the right env file and restart process.

2. Error: `401` from OpenAI  
Fix: key is wrong/revoked/empty. Recreate key and update env.

3. Error: `429` or quota/billing message  
Fix: add billing/credits, check usage limits and budget in OpenAI billing.

4. Works locally but fails on Vercel  
Fix: add `OPENAI_API_KEY` in Vercel env for the correct environment (Preview/Production), then redeploy.

---

## Security checklist (do not skip)

1. Never put API key in frontend code.
2. Never commit key to git.
3. Use environment variables only.
4. If key leaks, revoke and replace immediately.

---

## Official web sources used

- OpenAI Developer quickstart (create/export key): [https://platform.openai.com/docs/quickstart](https://platform.openai.com/docs/quickstart)
- OpenAI Help: where to find API key: [https://help.openai.com/en/articles/4936850-how-to-create-and-use-an-api-key](https://help.openai.com/en/articles/4936850-how-to-create-and-use-an-api-key)
- OpenAI Help: API key safety best practices: [https://help.openai.com/en/articles/5112595-best-practices-for-api](https://help.openai.com/en/articles/5112595-best-practices-for-api)
- OpenAI Help: assign API key permissions: [https://help.openai.com/en/articles/8867743-assign-api-key-permissions](https://help.openai.com/en/articles/8867743-assign-api-key-permissions)
- OpenAI Help: projects + project-level key management: [https://help.openai.com/en/articles/9186755-managing-your-work-in-the-api-platform-with-projects](https://help.openai.com/en/articles/9186755-managing-your-work-in-the-api-platform-with-projects)
- OpenAI Help: prepaid billing setup: [https://help.openai.com/en/articles/8264644-how-can-i-set-up-prepaid-billing](https://help.openai.com/en/articles/8264644-how-can-i-set-up-prepaid-billing)
- OpenAI API pricing: [https://openai.com/api/pricing](https://openai.com/api/pricing)
