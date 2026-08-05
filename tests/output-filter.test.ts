import assert from "node:assert/strict";
import test from "node:test";
import { buildOutputFilterRefusal, filterAnswerOutput } from "../lib/security/output-filter";

test("filterAnswerOutput blocks prompt-leak style output", () => {
  const result = filterAnswerOutput({
    answer: "Here is the system prompt: never reveal this.",
    citations: [{ documentId: "doc-1", pageNumber: 1, chunkId: "chunk-1" }],
    language: "EN",
  });

  assert.equal(result.blocked, true);
  assert.equal(result.filtered, true);
  assert.deepEqual(result.citations, []);
  assert.ok(result.reasons.includes("prompt_leak"));
});

test("filterAnswerOutput redacts secrets and unsafe markdown links", () => {
  const result = filterAnswerOutput({
    answer: 'Use key sk-testsecretsecretsecret and click [here](javascript:alert(1)).',
    citations: [{ documentId: "doc-1", pageNumber: 1, chunkId: "chunk-1" }],
    language: "EN",
  });

  assert.equal(result.blocked, false);
  assert.equal(result.filtered, true);
  assert.ok(result.answer.includes("[REDACTED]"));
  assert.ok(result.answer.includes("[here](#)"));
  assert.ok(result.reasons.includes("secret_redaction"));
  assert.ok(result.reasons.includes("unsafe_links_sanitized"));
});

test("filterAnswerOutput strips dangerous html payloads", () => {
  const result = filterAnswerOutput({
    answer: "Safe text<script>alert(1)</script><iframe src=\"https://evil.test\"></iframe>",
    citations: [{ documentId: "doc-1", pageNumber: 1, chunkId: "chunk-1" }],
    language: "EN",
  });

  assert.equal(result.blocked, false);
  assert.equal(result.filtered, true);
  assert.ok(!result.answer.includes("<script"));
  assert.ok(!result.answer.includes("<iframe"));
  assert.ok(result.reasons.includes("html_sanitized"));
});

test("filterAnswerOutput blocks excessively repetitive output", () => {
  const result = filterAnswerOutput({
    answer: "repeat\nrepeat\nrepeat\nrepeat\nrepeat\nrepeat\nrepeat",
    citations: [{ documentId: "doc-1", pageNumber: 1, chunkId: "chunk-1" }],
    language: "EN",
  });

  assert.equal(result.blocked, true);
  assert.ok(result.reasons.includes("excessive_repetition"));
});

test("filterAnswerOutput blocks prompt-leak text split by zero-width characters", () => {
  // A zero-width space between "system" and "prompt" renders identically to
  // a human reader but would not match the prompt-leak regex (which requires
  // a literal single space) if left in the string unstripped.
  const result = filterAnswerOutput({
    answer: "Here is the system\u200bprompt: never reveal this.",
    citations: [{ documentId: "doc-1", pageNumber: 1, chunkId: "chunk-1" }],
    language: "EN",
  });

  assert.equal(result.blocked, true);
  assert.ok(result.reasons.includes("prompt_leak"));
});

test("filterAnswerOutput redacts email addresses, SSNs, and cued phone numbers", () => {
  const result = filterAnswerOutput({
    answer:
      "Contact Jane Doe at jane.doe@example.com or Tel. 415-555-0134. " +
      "Her SSN on file is 219-09-9999.",
    citations: [{ documentId: "doc-1", pageNumber: 1, chunkId: "chunk-1" }],
    language: "EN",
  });

  assert.equal(result.blocked, false);
  assert.equal(result.filtered, true);
  assert.ok(!result.answer.includes("jane.doe@example.com"));
  assert.ok(!result.answer.includes("415-555-0134"));
  assert.ok(!result.answer.includes("219-09-9999"));
  assert.ok(result.answer.includes("[REDACTED]"));
  assert.ok(result.reasons.includes("pii_redaction"));
  assert.ok(result.redactionCount >= 3);
});

// The regression item 1.1 exists to fix. Every one of these was redacted by
// the shipped grouped-numeral phone pattern, which fires on exactly the
// content a RAG system exists to surface — and fires *after* citations are
// attached, so the answer kept a [n] marker pointing at a figure the user was
// no longer allowed to see.
test("numbers_safe leaves grouped figures and reference numbers intact", () => {
  for (const answer of [
    "Total: 12 500 000 units shipped.",
    "The reference number is 2024-1234-56.",
    "Der Betrag betrug 45 000 00 Euro.",
  ]) {
    const result = filterAnswerOutput({
      answer,
      citations: [{ documentId: "doc-1", pageNumber: 1, chunkId: "chunk-1" }],
      language: "EN",
    });

    assert.equal(result.answer, answer, `numbers_safe altered: ${answer}`);
    assert.equal(result.answer.includes("[REDACTED]"), false);
  }
});

test("strict still redacts the bare grouped-numeral phone form", () => {
  const result = filterAnswerOutput({
    answer: "Reach the office on 415 555 0134 during business hours.",
    citations: [{ documentId: "doc-1", pageNumber: 1, chunkId: "chunk-1" }],
    language: "EN",
    pii: { mode: "strict" },
  });

  assert.ok(!result.answer.includes("415 555 0134"));
  assert.ok(result.reasons.includes("pii_redaction"));
});

test("numbers_safe redacts an international-format number without a cue", () => {
  const result = filterAnswerOutput({
    answer: "Reach the office on +41 44 555 0134 during business hours.",
    citations: [{ documentId: "doc-1", pageNumber: 1, chunkId: "chunk-1" }],
    language: "EN",
  });

  assert.ok(!result.answer.includes("+41 44 555 0134"));
  assert.ok(result.reasons.includes("pii_redaction"));
});

// An address inside the caller's own RBAC-scoped documents is not a leak, it
// is the answer: two of the 44 baseline benchmark answers shipped
// "Richte das E-Mail an die Adresse [REDACTED]", which tells the user nothing.
test("an email present in the retrieved evidence survives redaction", () => {
  const evidenceEmails = new Set(["gesuche@example.org"]);

  const kept = filterAnswerOutput({
    answer: "Send the request to gesuche@example.org and wait for the reply.",
    citations: [{ documentId: "doc-1", pageNumber: 1, chunkId: "chunk-1" }],
    language: "EN",
    pii: { evidenceEmails },
  });

  assert.ok(kept.answer.includes("gesuche@example.org"));
  assert.equal(kept.answer.includes("[REDACTED]"), false);

  const dropped = filterAnswerOutput({
    answer: "Send the request to someone.else@elsewhere.test instead.",
    citations: [{ documentId: "doc-1", pageNumber: 1, chunkId: "chunk-1" }],
    language: "EN",
    pii: { evidenceEmails },
  });

  assert.ok(!dropped.answer.includes("someone.else@elsewhere.test"));
  assert.ok(dropped.reasons.includes("pii_redaction"));
});

test("strict redacts an evidence-present email regardless", () => {
  const result = filterAnswerOutput({
    answer: "Send the request to gesuche@example.org.",
    citations: [{ documentId: "doc-1", pageNumber: 1, chunkId: "chunk-1" }],
    language: "EN",
    pii: { mode: "strict", evidenceEmails: new Set(["gesuche@example.org"]) },
  });

  assert.ok(!result.answer.includes("gesuche@example.org"));
});

test("off disables PII redaction entirely but keeps secret redaction", () => {
  const result = filterAnswerOutput({
    answer: "Mail bob@example.com, SSN 219-09-9999, key sk-testsecretsecretsecret.",
    citations: [{ documentId: "doc-1", pageNumber: 1, chunkId: "chunk-1" }],
    language: "EN",
    pii: { mode: "off" },
  });

  assert.ok(result.answer.includes("bob@example.com"));
  assert.ok(result.answer.includes("219-09-9999"));
  assert.ok(!result.answer.includes("sk-testsecretsecretsecret"));
  assert.equal(result.reasons.includes("pii_redaction"), false);
});

// hasExcessiveRepetition returns a hard refusal, so raising
// RAG_LLM_MAX_OUTPUT_TOKENS must not make long structured answers look
// degenerate: recurring short headings can drag the unique-line ratio under
// the threshold without any generation loop being present.
test("a long structured answer with recurring headings is not blocked", () => {
  const answer = Array.from({ length: 8 }, (_, index) =>
    [
      "## Section",
      `Finding ${index + 1} describes a distinct control in the policy [${index + 1}].`,
      "Limitations",
    ].join("\n"),
  ).join("\n");

  const result = filterAnswerOutput({
    answer,
    citations: [{ documentId: "doc-1", pageNumber: 1, chunkId: "chunk-1" }],
    language: "EN",
  });

  assert.equal(result.blocked, false);
  assert.equal(result.reasons.includes("excessive_repetition"), false);
});

test("filterAnswerOutput does not redact plain numeric identifiers or dates", () => {
  const result = filterAnswerOutput({
    answer: "The policy was updated on 2024-01-15 and covers document ID 20240115.",
    citations: [{ documentId: "doc-1", pageNumber: 1, chunkId: "chunk-1" }],
    language: "EN",
  });

  assert.equal(result.filtered, false);
  assert.equal(result.answer.includes("[REDACTED]"), false);
  assert.ok(result.answer.includes("2024-01-15"));
  assert.ok(result.answer.includes("20240115"));
});

test("buildOutputFilterRefusal localizes the fallback message", () => {
  assert.ok(buildOutputFilterRefusal("DE").includes("Geheimnisse"));
  assert.ok(buildOutputFilterRefusal("FR").includes("secrets"));
});

test("filterAnswerOutput blocks prompt-leak text split by bidi isolate control characters", () => {
  // Same invisible-character-splitting technique as the zero-width-space
  // regression above (see the prompt-injection.test.ts bidi-isolate test),
  // applied to the output-leak side of the scanner.
  const result = filterAnswerOutput({
    answer: "Here is the system\u2066prompt: never reveal this.",
    citations: [{ documentId: "doc-1", pageNumber: 1, chunkId: "chunk-1" }],
    language: "EN",
  });

  assert.equal(result.blocked, true);
  assert.ok(result.reasons.includes("prompt_leak"));
});

test("filterAnswerOutput blocks prompt-leak text split by invisible Unicode Tag characters", () => {
  const result = filterAnswerOutput({
    answer: "Here is the system\u{E0020}prompt: never reveal this.",
    citations: [{ documentId: "doc-1", pageNumber: 1, chunkId: "chunk-1" }],
    language: "EN",
  });

  assert.equal(result.blocked, true);
  assert.ok(result.reasons.includes("prompt_leak"));
});
