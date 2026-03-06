import type { RetrievedChunk, RetrievalTrace, SupportedLanguage } from "@/lib/contracts/retrieval";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

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

  await supabase
    .from("retrieval_cache")
    .update({
      hit_count: Math.max(0, (data.hit_count ?? 0) + 1),
      last_accessed_at: nowIso,
    })
    .eq("cache_key", input.cacheKey);

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

  const { error } = await supabase.from("retrieval_cache").upsert(
    {
      cache_key: input.cacheKey,
      normalized_query: input.normalizedQuery,
      language: input.language,
      retrieval_version: input.retrievalVersion,
      chunk_ids: input.chunks.map((chunk) => chunk.chunkId),
      payload: {
        topK: input.topK,
        chunks: input.chunks,
        candidateCounts: input.candidateCounts,
      },
      hit_count: 0,
      created_at: nowIso,
      expires_at: expiresAtIso,
      last_accessed_at: nowIso,
    },
    { onConflict: "cache_key" },
  );

  if (error) {
    throw new Error(`Retrieval cache write failed: ${error.message}`);
  }
}

export async function pruneRetrievalCache(currentRetrievalVersion: number): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const nowIso = new Date().toISOString();

  const [expiredResult, oldVersionResult] = await Promise.all([
    supabase.from("retrieval_cache").delete().lte("expires_at", nowIso),
    supabase.from("retrieval_cache").delete().lt("retrieval_version", currentRetrievalVersion),
  ]);

  if (expiredResult.error) {
    throw new Error(`Retrieval cache prune failed for expired entries: ${expiredResult.error.message}`);
  }

  if (oldVersionResult.error) {
    throw new Error(`Retrieval cache prune failed for old versions: ${oldVersionResult.error.message}`);
  }
}
