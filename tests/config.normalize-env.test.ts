import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { normalizeEnvValues } from "@/lib/config/normalize-env";

test("normalizeEnvValues strips surrounding whitespace from string values", () => {
  const normalized = normalizeEnvValues({
    URL: "https://example.org\n",
    PADDED: "  value  ",
    CLEAN: "value",
  });

  assert.equal(normalized.URL, "https://example.org");
  assert.equal(normalized.PADDED, "value");
  assert.equal(normalized.CLEAN, "value");
});

test("normalizeEnvValues treats whitespace-only values as unset", () => {
  const normalized = normalizeEnvValues({
    EMPTY: "",
    BLANK: "   ",
    NEWLINE_ONLY: "\n",
  });

  assert.equal(normalized.EMPTY, undefined);
  assert.equal(normalized.BLANK, undefined);
  assert.equal(normalized.NEWLINE_ONLY, undefined);
});

test("normalizeEnvValues leaves non-string values untouched", () => {
  const normalized = normalizeEnvValues({
    ABSENT: undefined,
    NUMERIC: 5,
    FLAG: true,
  });

  assert.equal(normalized.ABSENT, undefined);
  assert.equal(normalized.NUMERIC, 5);
  assert.equal(normalized.FLAG, true);
});

// The failure modes this exists to prevent, each expressed with the Zod
// construct the real schema uses. Zod catches none of them: they produce a
// wrong value while reporting success, which is why normalisation has to
// happen before the schema rather than field by field.

test("a trailing newline no longer inverts a boolean feature flag", () => {
  // Mirrors RAG_WEB_SEARCH_ENABLED / AUTH_DEV_INSECURE_BYPASS. The preprocessor
  // sees the raw value and compares with ===, so a newline silently turns a
  // flag that was set to "true" into false.
  const flag = z.preprocess(
    (val) => val === "true" || val === "1" || val === true,
    z.boolean().default(false),
  );

  assert.equal(flag.parse("true\n"), false, "documents the original defect");
  assert.equal(
    flag.parse(normalizeEnvValues({ V: "true\n" }).V),
    true,
    "normalisation restores the intended value",
  );
});

test("a trailing newline no longer survives a plain string secret", () => {
  // OPENAI_API_KEY, SUPABASE_*_KEY, and RAG_WEB_SEARCH_API_KEY are plain
  // `z.string().min(1)`, which preserves whitespace verbatim. These values go
  // straight into Authorization headers, where a newline is not merely wrong
  // but an illegal header value.
  const secret = z.string().min(1);
  const raw = "sk-example-key\n";

  assert.equal(secret.parse(raw), raw, "documents the original defect");
  assert.equal(
    secret.parse(normalizeEnvValues({ K: raw }).K),
    "sk-example-key",
  );
});

test("a whitespace-only value falls back to the schema default", () => {
  // "  " is truthy and passes .min(1), so it shadowed the default instead of
  // being treated as unset.
  const name = z.string().min(1).default("RAG System");

  assert.equal(name.parse("  "), "  ", "documents the original defect");
  assert.equal(name.parse(normalizeEnvValues({ N: "  " }).N), "RAG System");
});

test("z.string().url() already normalises, and normalisation does not change that", () => {
  // Recorded so the URL fields are not mistaken for a defect this fixes: Zod's
  // url() returns a normalised URL, so NEXT_PUBLIC_APP_URL was clean at runtime
  // even while the stored Vercel value carried a trailing newline. Only the raw
  // value — as read from `vercel env pull` or `process.env` directly, bypassing
  // this schema — was affected.
  const url = z.string().url();

  assert.equal(url.parse("https://example.org\n"), "https://example.org");
  assert.equal(
    url.parse(normalizeEnvValues({ U: "https://example.org\n" }).U as string),
    "https://example.org",
  );
});
