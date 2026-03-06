import { createHash } from "node:crypto";
import type { SupportedLanguage } from "@/lib/contracts/retrieval";

type CacheKeyInput = {
  normalizedQuery: string;
  language: SupportedLanguage;
  retrievalVersion: number;
  topK: number;
};

export function buildRetrievalCacheKey(input: CacheKeyInput): string {
  return createHash("sha256")
    .update(
      `${input.normalizedQuery}::${input.language}::v${input.retrievalVersion}::k${input.topK}`,
      "utf8",
    )
    .digest("hex");
}
