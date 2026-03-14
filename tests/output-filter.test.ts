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

test("buildOutputFilterRefusal localizes the fallback message", () => {
  assert.ok(buildOutputFilterRefusal("DE").includes("Geheimnisse"));
  assert.ok(buildOutputFilterRefusal("FR").includes("secrets"));
});
