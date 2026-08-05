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
 * `RAG_HYDE_ENABLED` is deliberately absent: HyDE adds a retrieval *branch* in
 * the router, each of which already caches under its own namespace, and does
 * not change what any single branch returns.
 */
export type RetrievalConfig = {
  crossEncoderEnabled: boolean;
  crossEncoderModel: string;
  /** Changes the document text the cross-encoder scores. */
  crossEncoderIncludeContext: boolean;
  rerankPoolSize: number;
  rrfK: number;
  contextualGroupingEnabled: boolean;
  /** Changes the ordering the grouping stage produces. */
  adjacencyBoost: number;
  /** Changes final topK membership (soft per-document cap; 0 = off). */
  maxChunksPerDocument: number;
  /** Qualification floor for diversity promotion. */
  diversityRelevanceFloor: number;
  multiQueryEnabled: boolean;
  /** Changes the merged vector candidate set within a single cache key. */
  multiQueryVariations: number;
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
        `cectx:${config.crossEncoderIncludeContext}`,
        `pool:${config.rerankPoolSize}`,
        `rrfk:${config.rrfK}`,
        `group:${config.contextualGroupingEnabled}`,
        `adjb:${config.adjacencyBoost}`,
        `maxdoc:${config.maxChunksPerDocument}`,
        `divfloor:${config.diversityRelevanceFloor}`,
        `mq:${config.multiQueryEnabled}`,
        `mqv:${config.multiQueryVariations}`,
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
