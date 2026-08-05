import assert from "node:assert/strict";
import test from "node:test";

function ensureRetrievalTestEnv(): void {
  process.env.SUPABASE_URL ??= "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY ??= "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-key";
  process.env.OPENAI_API_KEY ??= "test-openai-key";
}

// Decomposition skips queries under 12 words, so test originals must be long
// enough to reach the LLM path.
const BLENDED_QUERY =
  "How do the perceptions of AI in the workplace relate to the support provided to vulnerable migrants?";

function stubAnswer(text: string) {
  return async () => ({ text });
}

test("decomposeQuery returns validated sub-queries from a JSON array", async () => {
  ensureRetrievalTestEnv();
  const { decomposeQuery } = await import("../lib/retrieval/decomposition");

  const result = await decomposeQuery(BLENDED_QUERY, "EN", {
    generateAnswer: stubAnswer(
      '["What are perceptions of AI in the workplace?", "What support is provided to vulnerable migrants?"]',
    ),
  });

  assert.deepEqual(result, [
    "What are perceptions of AI in the workplace?",
    "What support is provided to vulnerable migrants?",
  ]);
});

test("decomposeQuery skips the LLM entirely for short queries", async () => {
  ensureRetrievalTestEnv();
  const { decomposeQuery } = await import("../lib/retrieval/decomposition");

  let llmCalls = 0;
  const result = await decomposeQuery(
    "How does onboarding relate to security?",
    "EN",
    {
      generateAnswer: async () => {
        llmCalls += 1;
        return { text: '["Topic A details", "Topic B details"]' };
      },
    },
  );

  assert.equal(llmCalls, 0);
  assert.deepEqual(result, []);
});

test("decomposeQuery returns [] when the LLM declines to split", async () => {
  ensureRetrievalTestEnv();
  const { decomposeQuery } = await import("../lib/retrieval/decomposition");

  const result = await decomposeQuery(BLENDED_QUERY, "EN", {
    generateAnswer: stubAnswer("[]"),
  });

  assert.deepEqual(result, []);
});

test("decomposeQuery treats a single surviving sub-query as no decomposition", async () => {
  // One sub-query is a paraphrase, not a decomposition; the multi-query path
  // owns paraphrasing.
  ensureRetrievalTestEnv();
  const { decomposeQuery } = await import("../lib/retrieval/decomposition");

  const result = await decomposeQuery(BLENDED_QUERY, "EN", {
    generateAnswer: stubAnswer('["Only one topic here"]'),
  });

  assert.deepEqual(result, []);
});

test("decomposeQuery drops entries equal to the original and case-insensitive duplicates", async () => {
  ensureRetrievalTestEnv();
  const { decomposeQuery } = await import("../lib/retrieval/decomposition");

  const result = await decomposeQuery(BLENDED_QUERY, "EN", {
    generateAnswer: stubAnswer(
      `["${BLENDED_QUERY}", "Topic A details", "topic a details", "Topic B details"]`,
    ),
  });

  assert.deepEqual(result, ["Topic A details", "Topic B details"]);
});

test("decomposeQuery returns [] on non-JSON output", async () => {
  ensureRetrievalTestEnv();
  const { decomposeQuery } = await import("../lib/retrieval/decomposition");

  const result = await decomposeQuery(BLENDED_QUERY, "EN", {
    generateAnswer: stubAnswer("I cannot split this query."),
  });

  assert.deepEqual(result, []);
});

test("decomposeQuery returns [] when the LLM call rejects", async () => {
  ensureRetrievalTestEnv();
  const { decomposeQuery } = await import("../lib/retrieval/decomposition");

  const result = await decomposeQuery(BLENDED_QUERY, "EN", {
    generateAnswer: async () => {
      throw new Error("provider unavailable");
    },
  });

  assert.deepEqual(result, []);
});

test("decomposeQuery ignores non-string and empty entries", async () => {
  ensureRetrievalTestEnv();
  const { decomposeQuery } = await import("../lib/retrieval/decomposition");

  const result = await decomposeQuery(BLENDED_QUERY, "EN", {
    generateAnswer: stubAnswer('[42, "", "  ", "Topic A", null, "Topic B"]'),
  });

  assert.deepEqual(result, ["Topic A", "Topic B"]);
});

test("decomposeQuery caps sub-queries at the configured maximum", async () => {
  ensureRetrievalTestEnv();
  const { env } = await import("../lib/config/env");
  const { decomposeQuery } = await import("../lib/retrieval/decomposition");

  const mutable = env as unknown as Record<string, unknown>;
  const previous = mutable.RAG_QUERY_DECOMPOSITION_MAX_SUBQUERIES;
  mutable.RAG_QUERY_DECOMPOSITION_MAX_SUBQUERIES = 2;
  try {
    const result = await decomposeQuery(BLENDED_QUERY, "EN", {
      generateAnswer: stubAnswer('["Topic A", "Topic B", "Topic C"]'),
    });
    assert.deepEqual(result, ["Topic A", "Topic B"]);
  } finally {
    mutable.RAG_QUERY_DECOMPOSITION_MAX_SUBQUERIES = previous;
  }
});

test("memoizeDecomposition caches by language and query", async () => {
  ensureRetrievalTestEnv();
  const { memoizeDecomposition } =
    await import("../lib/retrieval/decomposition");

  let calls = 0;
  const memoized = memoizeDecomposition(async (query, language) => {
    calls += 1;
    return [`${language}:${query}:a`, `${language}:${query}:b`];
  });

  const first = await memoized("blended query text", "EN");
  const repeat = await memoized("blended query text", "EN");
  assert.equal(calls, 1);
  assert.deepEqual(repeat, first);

  await memoized("blended query text", "DE");
  assert.equal(calls, 2);
});

test("memoizeDecomposition evicts the oldest entry at capacity", async () => {
  ensureRetrievalTestEnv();
  const { memoizeDecomposition } =
    await import("../lib/retrieval/decomposition");

  let calls = 0;
  const memoized = memoizeDecomposition(async () => {
    calls += 1;
    return ["a", "b"];
  }, 2);

  await memoized("query one", "EN");
  await memoized("query two", "EN");
  await memoized("query three", "EN"); // evicts "query one"
  await memoized("query one", "EN"); // re-computed
  assert.equal(calls, 4);
  await memoized("query three", "EN"); // still cached
  assert.equal(calls, 4);
});
