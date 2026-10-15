import assert from "node:assert/strict";
import test from "node:test";
import type { RetrievedChunk } from "../lib/contracts/retrieval";

process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY ??= "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-key";
process.env.OPENAI_API_KEY ??= "test-openai-key";

function buildChunk(index: number): RetrievedChunk {
  return {
    chunkId: `chunk-${index}`,
    documentId: "doc-1",
    pageNumber: index,
    sectionTitle: `Section ${index}`,
    content: `Evidence text ${index}.`,
    context: "",
    language: "EN",
    source: "hybrid",
    retrievalScore: 0.2,
  };
}

/** Runs the verifier against a stubbed endpoint and returns the claim lines it sent. */
async function claimsSentFor(answer: string): Promise<string[]> {
  const { verifyCitedStatements } = await import("../lib/answering/verification");
  const originalFetch = globalThis.fetch;
  let userPrompt = "";
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    userPrompt = body.messages.find((m) => m.role === "user")!.content;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"verdicts":[true,true]}' } }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    await verifyCitedStatements({
      answer,
      chunks: [buildChunk(1), buildChunk(2)],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  return userPrompt
    .slice(userPrompt.indexOf("Claims ("))
    .split("\n")
    .slice(1);
}

test("markers placed after terminal punctuation stay with the sentence they close", async () => {
  // Split naively, this became "[1] The budget is fixed." citing chunk 1
  // and a bare "[2]" citing chunk 2, with the first sentence unchecked.
  const claims = await claimsSentFor(
    "Broadband reaches rural regions. [1] The budget is fixed. [2]",
  );

  assert.deepEqual(claims, [
    "1. (cites chunk 1) Broadband reaches rural regions. [1]",
    "2. (cites chunk 2) The budget is fixed. [2]",
  ]);
});

test("markers placed before terminal punctuation keep working", async () => {
  const claims = await claimsSentFor(
    "Broadband reaches rural regions [1]. The budget is fixed [2].",
  );

  assert.deepEqual(claims, [
    "1. (cites chunk 1) Broadband reaches rural regions [1].",
    "2. (cites chunk 2) The budget is fixed [2].",
  ]);
});
