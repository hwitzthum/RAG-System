import assert from "node:assert/strict";
import test from "node:test";

// The Kommandozentrale-facing surface (dashboard F2.4).
//
// These four routes are the only way into this app that is not a person, so the
// tests here are about the boundary rather than about retrieval: who is let in,
// what an unwired deployment does, and — the part that carries the whole design
// — that the token minted for the service account is one this app's own
// verifier accepts, with the claims its role resolution expects.

import { authenticated, configured } from "../lib/integration/auth";
import { sourcesToMarkdown } from "../lib/integration/answer-markdown";
import { askInputSchema, manifest } from "../lib/integration/manifest";

const TOKEN = "dashboard-token-0123456789abcdef";
const EMAIL = "kommandozentrale@rautaki.ch";

/**
 * Runs `fn` with these variables set, then restores what was there.
 *
 * Async-aware on purpose: a synchronous `finally` would restore the environment
 * the moment an async callback returned its promise — before its body had run —
 * so the code under test would see the restored values, not these.
 */
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function request(token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request("https://rag.example/api/run", {
    method: "POST",
    headers,
  });
}

test("integration is unconfigured until the token and the service account are both set", async () => {
  const none = {
    DASHBOARD_TOKEN: undefined,
    DASHBOARD_USER_EMAIL: undefined,
    DASHBOARD_USER_PASSWORD: undefined,
  };

  await withEnv(none, () => {
    assert.equal(configured(), false);
  });

  // A token with no account behind it authenticates a caller this app cannot
  // then act as — that is not "configured", it is half-wired.
  await withEnv({ ...none, DASHBOARD_TOKEN: TOKEN }, () => {
    assert.equal(configured(), false);
  });

  await withEnv(
    { ...none, DASHBOARD_TOKEN: TOKEN, DASHBOARD_USER_EMAIL: EMAIL },
    () => {
      assert.equal(configured(), false);
    },
  );

  await withEnv(
    {
      DASHBOARD_TOKEN: TOKEN,
      DASHBOARD_USER_EMAIL: EMAIL,
      DASHBOARD_USER_PASSWORD: "a-password",
    },
    () => {
      assert.equal(configured(), true);
    },
  );
});

test("a missing, malformed or wrong token is refused identically", async () => {
  await withEnv({ DASHBOARD_TOKEN: TOKEN }, () => {
    for (const candidate of [
      null,
      "",
      "wrong",
      `${TOKEN}x`,
      TOKEN.slice(0, -1),
    ]) {
      assert.equal(authenticated(request(candidate)), false, String(candidate));
    }
    assert.equal(authenticated(request(TOKEN)), true);
  });
});

test("no token configured means no caller is ever authenticated", async () => {
  await withEnv({ DASHBOARD_TOKEN: undefined }, () => {
    assert.equal(authenticated(request(TOKEN)), false);
  });
});

test("the manifest describes both capabilities and derives its input schema", () => {
  const document = manifest();

  assert.equal(document.app, "rag-system");
  assert.deepEqual(
    document.capabilities.map((capability) => capability.id),
    ["answer", "document"],
  );

  const answer = document.capabilities[0];
  assert.equal(answer.resultKind, "answer");

  // An upload produces an indexed document, not a delivery — saying so in the
  // manifest keeps the dashboard from waiting for a result that never comes.
  const upload = document.capabilities[1];
  assert.equal(upload.resultKind, null);
  assert.equal(upload.upload?.accept, "application/pdf");

  assert.deepEqual(Object.keys(document.input.properties ?? {}).sort(), [
    "clientRef",
    "enableWebResearch",
    "question",
    "topK",
  ]);
});

test("the question schema matches what /api/query will accept", () => {
  assert.equal(askInputSchema.safeParse({ question: "" }).success, false);
  assert.equal(
    askInputSchema.safeParse({ question: "x".repeat(2001) }).success,
    false,
    "the query route caps a query at 2000 characters",
  );
  assert.equal(
    askInputSchema.safeParse({ question: "Wie läuft das?" }).success,
    true,
  );
  assert.equal(
    askInputSchema.safeParse({ question: "Frage", topK: 99 }).success,
    false,
    "topK above the query route's own maximum must not reach it",
  );
});

test("sources become a readable file, with pages folded per document", () => {
  const markdown = sourcesToMarkdown(
    "Wie läuft unser Mahnwesen?",
    "Dreistufig über CashCtrl.",
    [
      { documentId: "a", title: "Handbuch Finanzen.pdf", pages: [12, 14] },
      { documentId: "b", title: "Prozess Mahnwesen.pdf", pages: [3] },
    ],
  );

  assert.match(markdown, /^# Wie läuft unser Mahnwesen\?/);
  assert.match(markdown, /Dreistufig über CashCtrl\./);
  assert.match(markdown, /- Handbuch Finanzen\.pdf — S\. 12, 14/);
  assert.match(markdown, /- Prozess Mahnwesen\.pdf — S\. 3/);
});

test("an answer with no sources says so rather than showing an empty list", () => {
  const markdown = sourcesToMarkdown("Frage?", "Antwort.", []);
  assert.match(
    markdown,
    /Keine — die Antwort stützt sich auf keine Textstelle/,
  );
});

// The session the whole design rests on.
//
// This project signs tokens with an asymmetric ES256 key held by Supabase, so
// nothing here can mint one — the integration signs the service account in and
// uses the token Supabase issues. What is worth testing is the cache: a token
// lasts an hour, and a sign-in per request would add a round trip to every
// question for nothing.
test("the service session is fetched once and reused until it nears expiry", async () => {
  await withEnv(
    {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "anon-key",
      DASHBOARD_USER_EMAIL: "kommandozentrale@rautaki.ch",
      DASHBOARD_USER_PASSWORD: "correct horse",
    },
    async () => {
      const { serviceAuthHeaders, serviceUserId, forgetServiceSession } =
        await import("../lib/integration/service-user");
      forgetServiceSession();

      const calls: Array<{ url: string; body: unknown }> = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return new Response(
          JSON.stringify({
            access_token: "issued-token",
            expires_in: 3600,
            user: { id: "981cc5b1-5fe2-4b83-9d7a-da6daec0e320" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      try {
        const first = await serviceAuthHeaders();
        const second = await serviceAuthHeaders();
        const id = await serviceUserId();

        assert.equal(first.authorization, "Bearer issued-token");
        assert.equal(second.authorization, first.authorization);
        assert.equal(id, "981cc5b1-5fe2-4b83-9d7a-da6daec0e320");

        // Three uses, one sign-in.
        assert.equal(calls.length, 1);
        assert.match(calls[0].url, /grant_type=password$/);
        assert.deepEqual(calls[0].body, {
          email: "kommandozentrale@rautaki.ch",
          password: "correct horse",
        });
      } finally {
        globalThis.fetch = realFetch;
        forgetServiceSession();
      }
    },
  );
});

test("a refused sign-in is reported, not cached", async () => {
  await withEnv(
    {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "anon-key",
      DASHBOARD_USER_EMAIL: "kommandozentrale@rautaki.ch",
      DASHBOARD_USER_PASSWORD: "wrong",
    },
    async () => {
      const { serviceAuthHeaders, forgetServiceSession, ServiceUserError } =
        await import("../lib/integration/service-user");
      forgetServiceSession();

      const realFetch = globalThis.fetch;
      let attempts = 0;
      globalThis.fetch = (async () => {
        attempts += 1;
        return new Response(
          JSON.stringify({ error_description: "Invalid login credentials" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      try {
        await assert.rejects(() => serviceAuthHeaders(), ServiceUserError);
        // A failure must not poison the cache: the next call tries again.
        await assert.rejects(() => serviceAuthHeaders(), ServiceUserError);
        assert.equal(attempts, 2);
      } finally {
        globalThis.fetch = realFetch;
        forgetServiceSession();
      }
    },
  );
});

test("missing service credentials fail loudly rather than silently", async () => {
  await withEnv(
    {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "anon-key",
      DASHBOARD_USER_EMAIL: undefined,
      DASHBOARD_USER_PASSWORD: undefined,
    },
    async () => {
      const { serviceAuthHeaders, forgetServiceSession, ServiceUserError } =
        await import("../lib/integration/service-user");
      forgetServiceSession();

      await assert.rejects(() => serviceAuthHeaders(), ServiceUserError);
      forgetServiceSession();
    },
  );
});
