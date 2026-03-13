import assert from "node:assert/strict";
import test from "node:test";
import type { RetrievedChunk } from "../lib/contracts/retrieval";

function ensureRetrievalCacheEnv(): void {
  process.env.SUPABASE_URL ??= "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY ??= "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-key";
  process.env.OPENAI_API_KEY ??= "test-openai-key";
}

async function loadRetrievalCacheModule() {
  ensureRetrievalCacheEnv();
  return import("../lib/retrieval/cache");
}

type RetrievalCacheRpcClient = import("../lib/retrieval/cache").RetrievalCacheRpcClient;

function buildChunk(): RetrievedChunk {
  return {
    chunkId: "00000000-0000-0000-0000-000000000001",
    documentId: "doc-1",
    pageNumber: 1,
    sectionTitle: "Overview",
    content: "content",
    context: "context",
    language: "EN",
    source: "vector",
    retrievalScore: 0.9,
  };
}

test("upsertRetrievalCacheEntry succeeds when the RPC returns a row", async () => {
  const { resetRetrievalCacheContractCheckForTests, upsertRetrievalCacheEntry } = await loadRetrievalCacheModule();
  resetRetrievalCacheContractCheckForTests();
  const client: RetrievalCacheRpcClient = {
    async runCheckRequiredIngestionRpcsRpc(args) {
      return {
        data: (args.required_functions ?? []).map((function_name) => ({
          function_name,
          is_present: true,
        })),
        error: null,
      };
    },
    async runUpsertRetrievalCacheEntryRpc() {
      return {
        data: [
          {
            cache_key: "cache-1",
            retrieval_version: 3,
            expires_at: "2026-03-13T21:00:00.000Z",
            last_accessed_at: "2026-03-13T20:00:00.000Z",
          },
        ],
        error: null,
      };
    },
    async runTouchRetrievalCacheEntryRpc() {
      return { data: null, error: null };
    },
    async runPruneRetrievalCacheEntriesRpc() {
      return { data: null, error: null };
    },
  };

  await assert.doesNotReject(
    upsertRetrievalCacheEntry({
      client,
      payload: {
        cacheKey: "cache-1",
        normalizedQuery: "query",
        language: "EN",
        retrievalVersion: 3,
        topK: 3,
        chunks: [buildChunk()],
        candidateCounts: { vector: 1, keyword: 0, fused: 1, reranked: 1 },
        ttlSeconds: 60,
      },
      nowIso: "2026-03-13T20:00:00.000Z",
      expiresAtIso: "2026-03-13T21:00:00.000Z",
    }),
  );
});

test("touchRetrievalCacheEntry throws when the touch RPC is unavailable", async () => {
  const { resetRetrievalCacheContractCheckForTests, touchRetrievalCacheEntry } = await loadRetrievalCacheModule();
  resetRetrievalCacheContractCheckForTests();
  const client: RetrievalCacheRpcClient = {
    async runCheckRequiredIngestionRpcsRpc(args) {
      return {
        data: (args.required_functions ?? []).map((function_name) => ({
          function_name,
          is_present: true,
        })),
        error: null,
      };
    },
    async runUpsertRetrievalCacheEntryRpc() {
      return { data: null, error: null };
    },
    async runTouchRetrievalCacheEntryRpc() {
      return {
        data: null,
        error: { message: "Could not find the function public.touch_retrieval_cache_entry" },
      };
    },
    async runPruneRetrievalCacheEntriesRpc() {
      return { data: null, error: null };
    },
  };

  await assert.rejects(
    touchRetrievalCacheEntry({
      client,
      cacheKey: "cache-1",
      retrievalVersion: 3,
      lastAccessedAtIso: "2026-03-13T20:00:00.000Z",
    }),
    /Required retrieval cache RPC touch_retrieval_cache_entry is unavailable/,
  );
});

test("pruneRetrievalCacheEntries throws when the prune RPC is unavailable", async () => {
  const { pruneRetrievalCacheEntries, resetRetrievalCacheContractCheckForTests } = await loadRetrievalCacheModule();
  resetRetrievalCacheContractCheckForTests();
  const client: RetrievalCacheRpcClient = {
    async runCheckRequiredIngestionRpcsRpc(args) {
      return {
        data: (args.required_functions ?? []).map((function_name) => ({
          function_name,
          is_present: true,
        })),
        error: null,
      };
    },
    async runUpsertRetrievalCacheEntryRpc() {
      return { data: null, error: null };
    },
    async runTouchRetrievalCacheEntryRpc() {
      return { data: null, error: null };
    },
    async runPruneRetrievalCacheEntriesRpc() {
      return {
        data: null,
        error: { message: "Could not find the function public.prune_retrieval_cache_entries" },
      };
    },
  };

  await assert.rejects(
    pruneRetrievalCacheEntries({
      client,
      currentRetrievalVersion: 3,
      nowIso: "2026-03-13T20:00:00.000Z",
    }),
    /Required retrieval cache RPC prune_retrieval_cache_entries is unavailable/,
  );
});

test("touchRetrievalCacheEntry throws when the retrieval cache contract check finds a missing RPC", async () => {
  const { resetRetrievalCacheContractCheckForTests, touchRetrievalCacheEntry } = await loadRetrievalCacheModule();
  resetRetrievalCacheContractCheckForTests();
  const client: RetrievalCacheRpcClient = {
    async runCheckRequiredIngestionRpcsRpc() {
      return {
        data: [{ function_name: "upsert_retrieval_cache_entry", is_present: true }],
        error: null,
      };
    },
    async runUpsertRetrievalCacheEntryRpc() {
      return { data: null, error: null };
    },
    async runTouchRetrievalCacheEntryRpc() {
      throw new Error("touch RPC should not run when contract is incomplete");
    },
    async runPruneRetrievalCacheEntriesRpc() {
      return { data: null, error: null };
    },
  };

  await assert.rejects(
    touchRetrievalCacheEntry({
      client,
      cacheKey: "cache-1",
      retrievalVersion: 3,
      lastAccessedAtIso: "2026-03-13T20:00:00.000Z",
    }),
    /Missing required retrieval cache RPCs:/,
  );
});
