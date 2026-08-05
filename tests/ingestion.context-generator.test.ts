import assert from "node:assert/strict";
import test from "node:test";

import { ContextGenerator } from "../lib/ingestion/runtime/context-generator";
import { resolveIngestionRuntimeSettings } from "../lib/ingestion/runtime/types";
import type { ChunkCandidate } from "../lib/ingestion/runtime/types";

type CapturedRequest = {
  max_tokens: number;
  system: unknown;
  content: Array<{ type: string; text: string; cache_control?: unknown }>;
};

const quietLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Installs a stub Anthropic client on a ContextGenerator and records every
 * request it makes. The SDK client is private, so this reaches past the type —
 * the alternative is a network call in a unit test.
 */
function stubAnthropic(generator: ContextGenerator): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  const client = {
    messages: {
      create: async (request: Record<string, unknown>) => {
        const messages = request.messages as Array<{ content: unknown }>;
        const raw = messages[0]!.content;
        requests.push({
          max_tokens: request.max_tokens as number,
          system: request.system,
          content:
            typeof raw === "string"
              ? [{ type: "text", text: raw }]
              : (raw as CapturedRequest["content"]),
        });
        return {
          content: [{ type: "text", text: "generated context" }],
          usage: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            input_tokens: 0,
          },
        };
      },
    },
  };
  (generator as unknown as { anthropicClient: unknown }).anthropicClient =
    client;
  return requests;
}

function makeGenerator(): ContextGenerator {
  const settings = resolveIngestionRuntimeSettings({
    contextEnabled: true,
    anthropicApiKey: "test-key",
    openAiApiKey: null,
  });
  return new ContextGenerator(settings, quietLogger);
}

function makeChunks(count: number): ChunkCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    chunkIndex: index,
    pageNumber: index + 1,
    sectionTitle: `Section ${index}`,
    content: `Chunk body ${index}`,
    language: "EN" as const,
  }));
}

/** Comfortably past the 16,000-char cacheability floor. */
const LARGE_DOCUMENT = "Sachverhalt und Begruendung. ".repeat(1_000);

test("enrich caches the document on a user block, not the system prompt", async () => {
  const generator = makeGenerator();
  const requests = stubAnthropic(generator);

  await generator.enrich(makeChunks(2), {
    title: "Handbuch",
    summary: null,
    text: LARGE_DOCUMENT,
  });

  const chunkRequests = requests.filter((r) => r.max_tokens > 0);
  assert.equal(chunkRequests.length, 2);

  for (const request of chunkRequests) {
    // The 45-token system prompt is far below the 4,096-token minimum, so a
    // breakpoint there never created an entry.
    assert.equal(typeof request.system, "string");
    assert.equal(request.content.length, 2);
    assert.deepEqual(request.content[0]?.cache_control, {
      type: "ephemeral",
      ttl: "1h",
    });
    assert.match(request.content[0]!.text, /Full document text:/);
    // Volatile per-chunk content sits after the breakpoint.
    assert.equal(request.content[1]?.cache_control, undefined);
  }
});

test("enrich pre-warms the cache exactly once before the batches", async () => {
  const generator = makeGenerator();
  const requests = stubAnthropic(generator);

  // Two full batches of five, so a missing pre-warm would be ten cache writes.
  await generator.enrich(makeChunks(10), {
    title: "Handbuch",
    summary: null,
    text: LARGE_DOCUMENT,
  });

  const prewarms = requests.filter((r) => r.max_tokens === 0);
  assert.equal(prewarms.length, 1);
  assert.equal(requests[0]?.max_tokens, 0, "pre-warm must run first");
  assert.deepEqual(prewarms[0]?.content[0]?.cache_control, {
    type: "ephemeral",
    ttl: "1h",
  });
});

test("enrich skips caching for a document below the cacheable minimum", async () => {
  const generator = makeGenerator();
  const requests = stubAnthropic(generator);

  await generator.enrich(makeChunks(2), {
    title: "Kurz",
    summary: "A short summary.",
    text: "Too short to cache.",
  });

  // No pre-warm, and no cache_control anywhere: below 4,096 tokens the
  // breakpoint would create nothing while re-billing the document per chunk.
  assert.equal(requests.filter((r) => r.max_tokens === 0).length, 0);
  for (const request of requests) {
    assert.equal(request.content.length, 1);
    assert.equal(request.content[0]?.cache_control, undefined);
  }
});

test("enrich falls back to the summary path when no document text is supplied", async () => {
  const generator = makeGenerator();
  const requests = stubAnthropic(generator);

  await generator.enrich(makeChunks(1), {
    title: "Handbuch",
    summary: "One paragraph summary.",
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.content.length, 1);
  assert.match(requests[0]!.content[0]!.text, /Document summary:/);
});

test("summarizeDocument samples head, outline and tail rather than a head slice", async () => {
  const generator = makeGenerator();
  const requests = stubAnthropic(generator);

  const body = Array.from(
    { length: 400 },
    (_, index) => `Section ${index}\nBody line for section ${index}.`,
  ).join("\n");
  const text = `${body}\nCLOSING REMARKS AND FINAL PROVISIONS`;

  await generator.summarizeDocument({ title: "Handbuch", text });

  const prompt = requests[0]!.content[0]!.text;
  assert.match(prompt, /Section outline:/);
  // The end of a long document used to be invisible: the excerpt was the
  // first 6,000 characters and nothing else.
  assert.match(prompt, /CLOSING REMARKS AND FINAL PROVISIONS/);
});
