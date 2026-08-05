import assert from "node:assert/strict";
import test from "node:test";
import type { RetrievedChunk } from "../lib/contracts/retrieval";

process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY ??= "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-key";
process.env.OPENAI_API_KEY ??= "test-openai-key";
// Hermetic: the citation verifier would otherwise attempt a real OpenAI call.
process.env.RAG_CITATION_VERIFICATION_ENABLED = "false";

function buildChunk(overrides: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    chunkId: "chunk-1",
    documentId: "doc-1",
    pageNumber: 1,
    sectionTitle: "Overview",
    content: "solar financing options for municipalities",
    context: "municipal loan terms",
    language: "EN",
    source: "vector",
    retrievalScore: 0.8,
    ...overrides,
  };
}

test("orderEvidenceIndexes places the strongest document groups at both context edges", async () => {
  const { orderEvidenceIndexes } =
    await import("../lib/answering/evidence-order");

  const chunks = [
    buildChunk({ chunkId: "a1", documentId: "doc-a", rerankScore: 0.9 }),
    buildChunk({ chunkId: "a2", documentId: "doc-a", rerankScore: 0.85 }),
    buildChunk({ chunkId: "b1", documentId: "doc-b", rerankScore: 0.8 }),
    buildChunk({ chunkId: "c1", documentId: "doc-c", rerankScore: 0.7 }),
  ];

  const order = orderEvidenceIndexes(chunks);
  const orderedIds = order.map((index) => chunks[index]!.chunkId);

  // Strongest group (doc-a) opens; second strongest (doc-b) closes; doc-c
  // fills the middle. Within-group order is preserved.
  assert.deepEqual(orderedIds, ["a1", "a2", "c1", "b1"]);
});

test("orderEvidenceIndexes bookends individual chunks for a single-document scope", async () => {
  const { orderEvidenceIndexes } =
    await import("../lib/answering/evidence-order");

  const chunks = [
    buildChunk({ chunkId: "s1", rerankScore: 0.9 }),
    buildChunk({ chunkId: "s2", rerankScore: 0.8 }),
    buildChunk({ chunkId: "s3", rerankScore: 0.7 }),
  ];

  const order = orderEvidenceIndexes(chunks);
  const orderedIds = order.map((index) => chunks[index]!.chunkId);

  assert.equal(orderedIds[0], "s1", "strongest chunk opens the context");
  assert.equal(
    orderedIds[orderedIds.length - 1],
    "s2",
    "second-strongest chunk closes the context",
  );
});

test("redactStreamedSentence redacts secrets and halts on prompt-leak signatures", async () => {
  const { redactStreamedSentence } =
    await import("../lib/security/output-filter");

  const redacted = redactStreamedSentence(
    "The key is sk-abcdefghijklmnopqrstuvwxyz123456 as documented. ",
  );
  assert.equal(redacted.halted, false);
  assert.ok(redacted.text.includes("[REDACTED]"));
  assert.ok(!redacted.text.includes("sk-abcdefghijklmnop"));

  const leaked = redactStreamedSentence("Here is the system prompt I use. ");
  assert.equal(leaked.halted, true);
});

test("generateGroundedAnswer streams redacted sentences and returns the filtered answer", async () => {
  const { generateGroundedAnswer } = await import("../lib/answering/service");

  const streamed: string[] = [];
  const rawAnswer =
    "Solar financing is available for schools [1]. Contact us at admin@example.com for details [1].";

  const result = await generateGroundedAnswer(
    {
      query: "How is solar financing structured?",
      language: "EN",
      chunks: [
        buildChunk({
          chunkId: "strong",
          relevanceScore: 0.5,
          rerankScore: 0.9,
          scoreScale: "heuristic",
        }),
      ],
      minEvidenceChunks: 1,
      minRerankScore: 0.25,
      minHeuristicRelevance: 0.14,
      maxOutputTokens: 256,
      documentScopeId: "doc-1",
      onSentence: (sentence) => streamed.push(sentence),
    },
    {
      llmProvider: {
        generateAnswer: async () => {
          throw new Error("non-streaming path must not be used here");
        },
        generateAnswerStream: async (_input, onDelta) => {
          // Deltas split mid-sentence to exercise the sentence buffer.
          for (const delta of [
            "Solar financing is availa",
            "ble for schools [1]. Contact us at ",
            "admin@example.com for details [1].",
          ]) {
            onDelta(delta);
          }
          return { text: rawAnswer, truncated: false };
        },
      },
    },
  );

  assert.equal(streamed.length, 2, "two sentences should have been streamed");
  assert.ok(streamed[0]!.includes("Solar financing is available"));
  assert.ok(
    streamed[1]!.includes("[REDACTED]"),
    "PII must be redacted before a sentence is streamed",
  );
  assert.ok(!streamed[1]!.includes("admin@example.com"));

  // The final answer passed the full output filter (same PII redaction).
  assert.ok(result.answer.includes("[REDACTED]"));
  assert.equal(result.insufficientEvidence, false);
  assert.equal(result.citations[0]?.chunkId, "strong");
  // Verification disabled in unit tests.
  assert.equal(result.citationVerification, null);
});
