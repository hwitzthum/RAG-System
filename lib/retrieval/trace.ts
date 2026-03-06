import { createHash } from "node:crypto";
import type { SupportedLanguage } from "@/lib/contracts/retrieval";

type CacheKeyInput = {
  normalizedQuery: string;
  language: SupportedLanguage;
  retrievalVersion: number;
  topK: number;
  scopeKey: string;
};

const CACHE_KEY_SCHEMA_VERSION = 2;

export function buildRetrievalCacheKey(input: CacheKeyInput): string {
  return createHash("sha256")
    .update(
      `${input.normalizedQuery}::${input.language}::v${input.retrievalVersion}::k${input.topK}::scope${input.scopeKey}::schema${CACHE_KEY_SCHEMA_VERSION}`,
      "utf8",
    )
    .digest("hex");
}
