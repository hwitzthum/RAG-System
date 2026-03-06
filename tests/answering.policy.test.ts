import assert from "node:assert/strict";
import test from "node:test";
import { hasSufficientEvidence } from "../lib/answering/policy";
import type { RetrievedChunk } from "../lib/contracts/retrieval";

function buildChunk(overrides: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    chunkId: "chunk-1",
    documentId: "doc-1",
    pageNumber: 1,
    sectionTitle: "Overview",
    content: "baseline content",
    context: "baseline context",
    language: "EN",
    source: "hybrid",
    retrievalScore: 0.2,
    ...overrides,
  };
}

test("hasSufficientEvidence fails when no chunks are available", () => {
  const result = hasSufficientEvidence({
    chunks: [],
    minEvidenceChunks: 1,
    minRerankScore: 0.1,
  });

  assert.equal(result, false);
});

test("hasSufficientEvidence fails when scores are below threshold", () => {
  const result = hasSufficientEvidence({
    chunks: [buildChunk({ rerankScore: 0.03 }), buildChunk({ chunkId: "chunk-2", rerankScore: 0.05 })],
    minEvidenceChunks: 1,
    minRerankScore: 0.1,
  });

  assert.equal(result, false);
});

test("hasSufficientEvidence passes when rerank score meets threshold", () => {
  const result = hasSufficientEvidence({
    chunks: [buildChunk({ rerankScore: 0.12 })],
    minEvidenceChunks: 1,
    minRerankScore: 0.1,
  });

  assert.equal(result, true);
});

test("generateGroundedAnswer returns insufficient-evidence fallback when evidence is weak", async () => {
  process.env.SUPABASE_URL ??= "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY ??= "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-key";
  process.env.OPENAI_API_KEY ??= "test-openai-key";

  const { generateGroundedAnswer } = await import("../lib/answering/service");
  const result = await generateGroundedAnswer(
    {
      query: "What is the financing schedule?",
      language: "EN",
      chunks: [buildChunk({ rerankScore: 0.02 })],
      minEvidenceChunks: 1,
      minRerankScore: 0.1,
      maxOutputTokens: 200,
    },
    {
      llmProvider: {
        async generateAnswer() {
          return "This should not be used.";
        },
      },
    },
  );

  assert.equal(result.insufficientEvidence, true);
  assert.ok(result.answer.toLowerCase().includes("enough evidence"));
  assert.equal(result.citations.length, 1);
});
