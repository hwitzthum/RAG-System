import type { SupabaseClient } from "@supabase/supabase-js";
import type { RetrievedChunk, RetrievalTrace, SupportedLanguage } from "@/lib/contracts/retrieval";
import {
  assertRequiredRetrievalCacheRpcsAvailable,
  type RetrievalCacheContractCheckClient,
} from "@/lib/retrieval/cache-contract";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

export type CachedRetrievalResult = {
  chunks: RetrievedChunk[];
  candidateCounts: RetrievalTrace["candidateCounts"];
};

export type ReadRetrievalCacheInput = {
  cacheKey: string;
  retrievalVersion: number;
  topK: number;
};

export type WriteRetrievalCacheInput = {
  cacheKey: string;
  normalizedQuery: string;
  language: SupportedLanguage;
  retrievalVersion: number;
  topK: number;
  chunks: RetrievedChunk[];
  candidateCounts: RetrievalTrace["candidateCounts"];
  ttlSeconds: number;
};

type SupabaseError = {
  message: string;
};

type UpsertRetrievalCacheRow = Database["public"]["Functions"]["upsert_retrieval_cache_entry"]["Returns"][number];
type TouchRetrievalCacheRow = Database["public"]["Functions"]["touch_retrieval_cache_entry"]["Returns"][number];
type PruneRetrievalCacheRow = Database["public"]["Functions"]["prune_retrieval_cache_entries"]["Returns"][number];

export type RetrievalCacheRpcClient = {
  runCheckRequiredIngestionRpcsRpc(args: {
    required_functions?: string[];
  }): Promise<{
    data: Array<{ function_name: string; is_present: boolean }> | null;
    error: SupabaseError | null;
  }>;
  runUpsertRetrievalCacheEntryRpc(args: Database["public"]["Functions"]["upsert_retrieval_cache_entry"]["Args"]): Promise<{
    data: UpsertRetrievalCacheRow[] | null;
    error: SupabaseError | null;
  }>;
  runTouchRetrievalCacheEntryRpc(args: Database["public"]["Functions"]["touch_retrieval_cache_entry"]["Args"]): Promise<{
    data: TouchRetrievalCacheRow[] | null;
    error: SupabaseError | null;
  }>;
  runPruneRetrievalCacheEntriesRpc(
    args: Database["public"]["Functions"]["prune_retrieval_cache_entries"]["Args"],
  ): Promise<{
    data: PruneRetrievalCacheRow[] | null;
    error: SupabaseError | null;
  }>;
};

function buildMissingRetrievalCacheRpcError(functionName: string, details?: string): Error {
  const suffix = details ? ` (${details})` : "";
  return new Error(`Required retrieval cache RPC ${functionName} is unavailable${suffix}`);
}

let retrievalCacheContractCheckPromise: Promise<void> | null = null;

async function ensureRetrievalCacheContract(client: RetrievalCacheContractCheckClient): Promise<void> {
  if (!retrievalCacheContractCheckPromise) {
    retrievalCacheContractCheckPromise = assertRequiredRetrievalCacheRpcsAvailable({ client }).catch((error) => {
      retrievalCacheContractCheckPromise = null;
      throw error;
    });
  }

  await retrievalCacheContractCheckPromise;
}

export function resetRetrievalCacheContractCheckForTests(): void {
  retrievalCacheContractCheckPromise = null;
}

export function createRetrievalCacheRpcClient(supabase: SupabaseClient<Database>): RetrievalCacheRpcClient {
  return {
    async runCheckRequiredIngestionRpcsRpc(args) {
      const { data, error } = await supabase.rpc("check_required_ingestion_rpcs", args);
      return { data, error };
    },
    async runUpsertRetrievalCacheEntryRpc(args) {
      const { data, error } = await supabase.rpc("upsert_retrieval_cache_entry", args);
      return { data, error };
    },
    async runTouchRetrievalCacheEntryRpc(args) {
      const { data, error } = await supabase.rpc("touch_retrieval_cache_entry", args);
      return { data, error };
    },
    async runPruneRetrievalCacheEntriesRpc(args) {
      const { data, error } = await supabase.rpc("prune_retrieval_cache_entries", args);
      return { data, error };
    },
  };
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseCachedResult(payload: unknown): CachedRetrievalResult | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const payloadRecord = payload as Record<string, unknown>;
  const chunksValue = payloadRecord.chunks;
  const candidateCountsValue = payloadRecord.candidateCounts as Record<string, unknown> | undefined;

  if (!Array.isArray(chunksValue) || chunksValue.length === 0) {
    return null;
  }

  return {
    chunks: chunksValue as RetrievedChunk[],
    candidateCounts: {
      vector: asNumber(candidateCountsValue?.vector),
      keyword: asNumber(candidateCountsValue?.keyword),
      fused: asNumber(candidateCountsValue?.fused),
      reranked: asNumber(candidateCountsValue?.reranked, chunksValue.length),
    },
  };
}

export async function touchRetrievalCacheEntry(input: {
  client: RetrievalCacheRpcClient;
  cacheKey: string;
  retrievalVersion: number;
  lastAccessedAtIso: string;
}): Promise<boolean> {
  await ensureRetrievalCacheContract(input.client);
  const { data, error } = await input.client.runTouchRetrievalCacheEntryRpc({
    target_cache_key: input.cacheKey,
    target_retrieval_version: input.retrievalVersion,
    target_last_accessed_at: input.lastAccessedAtIso,
  });

  if (!error) {
    return Boolean(data?.[0]);
  }

  if (error.message.includes("Could not find the function")) {
    throw buildMissingRetrievalCacheRpcError("touch_retrieval_cache_entry", error.message);
  }

  throw new Error(`Retrieval cache touch failed via RPC: ${error.message}`);
}

export async function upsertRetrievalCacheEntry(input: {
  client: RetrievalCacheRpcClient;
  payload: WriteRetrievalCacheInput;
  nowIso: string;
  expiresAtIso: string;
}): Promise<void> {
  await ensureRetrievalCacheContract(input.client);
  const { data, error } = await input.client.runUpsertRetrievalCacheEntryRpc({
    target_cache_key: input.payload.cacheKey,
    target_normalized_query: input.payload.normalizedQuery,
    target_language: input.payload.language,
    target_retrieval_version: input.payload.retrievalVersion,
    target_chunk_ids: input.payload.chunks.map((chunk) => chunk.chunkId),
    target_payload: {
      topK: input.payload.topK,
      chunks: input.payload.chunks,
      candidateCounts: input.payload.candidateCounts,
    },
    target_created_at: input.nowIso,
    target_expires_at: input.expiresAtIso,
    target_last_accessed_at: input.nowIso,
  });

  if (!error) {
    if (!data?.[0]) {
      throw new Error(`upsert_retrieval_cache_entry returned no row for ${input.payload.cacheKey}`);
    }
    return;
  }

  if (error.message.includes("Could not find the function")) {
    throw buildMissingRetrievalCacheRpcError("upsert_retrieval_cache_entry", error.message);
  }

  throw new Error(`Retrieval cache write failed via RPC: ${error.message}`);
}

export async function pruneRetrievalCacheEntries(input: {
  client: RetrievalCacheRpcClient;
  currentRetrievalVersion: number;
  nowIso: string;
}): Promise<void> {
  await ensureRetrievalCacheContract(input.client);
  const { data, error } = await input.client.runPruneRetrievalCacheEntriesRpc({
    target_current_retrieval_version: input.currentRetrievalVersion,
    target_now: input.nowIso,
  });

  if (!error) {
    if (!data?.[0]) {
      throw new Error("prune_retrieval_cache_entries returned no row");
    }
    return;
  }

  if (error.message.includes("Could not find the function")) {
    throw buildMissingRetrievalCacheRpcError("prune_retrieval_cache_entries", error.message);
  }

  throw new Error(`Retrieval cache prune failed via RPC: ${error.message}`);
}

export async function readRetrievalCache(input: ReadRetrievalCacheInput): Promise<CachedRetrievalResult | null> {
  const supabase = getSupabaseAdminClient();
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from("retrieval_cache")
    .select("cache_key,payload,hit_count")
    .eq("cache_key", input.cacheKey)
    .eq("retrieval_version", input.retrievalVersion)
    .gt("expires_at", nowIso)
    .maybeSingle<{ cache_key: string; payload: unknown; hit_count: number }>();

  if (error) {
    throw new Error(`Retrieval cache lookup failed: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  const parsed = parseCachedResult(data.payload);
  if (!parsed) {
    return null;
  }

  const cachedTopK = parsed.chunks.slice(0, Math.max(1, input.topK));

  void touchRetrievalCacheEntry({
    client: createRetrievalCacheRpcClient(supabase),
    cacheKey: input.cacheKey,
    retrievalVersion: input.retrievalVersion,
    lastAccessedAtIso: nowIso,
  }).catch((updateError) => {
    console.warn(`Cache hit_count update failed: ${updateError instanceof Error ? updateError.message : String(updateError)}`);
  });

  return {
    chunks: cachedTopK,
    candidateCounts: parsed.candidateCounts,
  };
}

export async function writeRetrievalCache(input: WriteRetrievalCacheInput): Promise<void> {
  if (input.chunks.length === 0) {
    return;
  }

  const supabase = getSupabaseAdminClient();
  const now = Date.now();
  const expiresAtIso = new Date(now + Math.max(1, input.ttlSeconds) * 1000).toISOString();
  const nowIso = new Date(now).toISOString();

  await upsertRetrievalCacheEntry({
    client: createRetrievalCacheRpcClient(supabase),
    payload: input,
    nowIso,
    expiresAtIso,
  });
}

export async function pruneRetrievalCache(currentRetrievalVersion: number): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const nowIso = new Date().toISOString();

  await pruneRetrievalCacheEntries({
    client: createRetrievalCacheRpcClient(supabase),
    currentRetrievalVersion,
    nowIso,
  });
}
