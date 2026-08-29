import { createHash } from "node:crypto";
import type { SupportedLanguage } from "@/lib/contracts/retrieval";

type CacheKeyInput = {
  normalizedQuery: string;
  language: SupportedLanguage;
  retrievalVersion: number;
  topK: number;
  scopeKey: string;
  /** See `computeRetrievalConfigFingerprint`. */
  configFingerprint: string;
};

const CACHE_KEY_SCHEMA_VERSION = 2;

/**
 * Every setting that changes which chunks an otherwise identical query
 * returns.
 *
 * `RAG_RETRIEVAL_VERSION` remains the manual, corpus-level escape hatch; it
 * sat at 1 everywhere against a 24h `RAG_CACHE_TTL_SECONDS`, so flipping any
 * ranking flag kept serving the previous configuration's chunks for a day and
 * every A/B read as a no-op.
 *
 * `RAG_MULTI_QUERY_VARIATIONS` is deliberately absent: expansion adds
 * retrieval *branches* in the router, each of which already caches under its
 * own namespace, and does not change what any single branch returns.
 *
 * `RAG_QUERY_DECOMPOSITION_*` is deliberately absent for the same reason:
 * decomposition composes router branches (sub-queries cache under their own
 * query text), the base branch's call is argument-identical to the flag-off
 * world, and the merged window is never written to the cache. Tripwire: if
 * the merged window is ever cached under the base query's key, the flag must
 * move into this config and `CACHE_KEY_SCHEMA_VERSION` must bump.
 */
export type RetrievalConfig = {
  crossEncoderEnabled: boolean;
  crossEncoderModel: string;
  rerankPoolSize: number;
  rrfK: number;
  /** Changes final topK membership (soft per-document cap; 0 = off). */
  maxChunksPerDocument: number;
  /** Qualification floor for diversity promotion. */
  diversityRelevanceFloor: number;
  queryEmbeddingModel: string;
  queryEmbeddingDimensions: number;
};

/**
 * Short, stable hash of the ranking configuration. Env is read by the caller
 * rather than here so this module stays importable without a validated
 * environment.
 */
export function computeRetrievalConfigFingerprint(
  config: RetrievalConfig,
): string {
  return createHash("sha256")
    .update(
      [
        `ce:${config.crossEncoderEnabled}`,
        `cem:${config.crossEncoderModel}`,
        `pool:${config.rerankPoolSize}`,
        `rrfk:${config.rrfK}`,
        `maxdoc:${config.maxChunksPerDocument}`,
        `divfloor:${config.diversityRelevanceFloor}`,
        `emb:${config.queryEmbeddingModel}`,
        `dim:${config.queryEmbeddingDimensions}`,
      ].join("|"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 12);
}

export function buildRetrievalCacheKey(input: CacheKeyInput): string {
  return createHash("sha256")
    .update(
      `${input.normalizedQuery}::${input.language}::v${input.retrievalVersion}::k${input.topK}::scope${input.scopeKey}::cfg${input.configFingerprint}::schema${CACHE_KEY_SCHEMA_VERSION}`,
      "utf8",
    )
    .digest("hex");
}
