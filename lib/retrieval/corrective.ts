import { startActiveObservation } from "@langfuse/tracing";
import type {
  RetrievedChunk,
  SupportedLanguage,
} from "@/lib/contracts/retrieval";
import { env } from "@/lib/config/env";
import { resolveRelevance } from "@/lib/answering/policy";
import { summarizeChunks } from "@/lib/observability/trace-payloads";
import { generateQueryVariations } from "@/lib/retrieval/multi-query";
import { retrieveRankedCandidates } from "@/lib/retrieval/service";

/**
 * Merge candidate pools from several retrieval branches: dedupe by chunkId
 * keeping the entry with the best absolute relevance, sorted by that
 * relevance descending. Deliberately NOT the router's fuseBranchCandidates —
 * no rank fusion, no pool trimming — because the CRAG loop wants the widest
 * honest pool the branches produced, scored on the gate's own scale.
 */
export function mergeCandidatePools(
  pools: RetrievedChunk[][],
): RetrievedChunk[] {
  const byChunkId = new Map<string, RetrievedChunk>();
  for (const pool of pools) {
    for (const chunk of pool) {
      const existing = byChunkId.get(chunk.chunkId);
      if (!existing || resolveRelevance(chunk) > resolveRelevance(existing)) {
        byChunkId.set(chunk.chunkId, chunk);
      }
    }
  }
  return [...byChunkId.values()].sort(
    (a, b) => resolveRelevance(b) - resolveRelevance(a),
  );
}

export type CorrectiveRetrieveScope = {
  /** Same caller-scoped document allowlist used by the primary retrieval pass. */
  documentIds?: string[];
  cacheNamespace?: string;
};

/**
 * Second retrieval pass for the CRAG loop's ambiguous band: rephrase the
 * query, retrieve for the original plus each variation, and merge. Each
 * branch disables multi-query expansion — the variations ARE the branches,
 * and expanding them again would cost branches x variations embedding calls.
 *
 * `scope` must carry the same `documentIds`/`cacheNamespace` the caller used
 * for the primary retrieval pass — this pass hits the same unscoped
 * `match_document_chunks`/`search_document_chunks_keyword` RPCs, so omitting
 * it would search the entire corpus regardless of the caller's document
 * access, not just their originally-requested scope.
 */
export async function correctiveRetrieve(
  query: string,
  language: SupportedLanguage,
  scope: CorrectiveRetrieveScope = {},
): Promise<RetrievedChunk[]> {
  return startActiveObservation(
    "corrective-retrieve",
    async (observation) => {
      observation.update({ input: { query, language } });
      const chunks = await correctiveRetrieveUntraced(query, language, scope);
      observation.update({ output: summarizeChunks(chunks) });
      return chunks;
    },
    { asType: "span" },
  );
}

async function correctiveRetrieveUntraced(
  query: string,
  language: SupportedLanguage,
  { documentIds, cacheNamespace }: CorrectiveRetrieveScope,
): Promise<RetrievedChunk[]> {
  // generateQueryVariations returns [original, ...variations] and degrades
  // to [original] on timeout or unparseable output.
  const queries = await generateQueryVariations(query, language);

  const results = await Promise.all(
    queries.map((variation) =>
      retrieveRankedCandidates({
        query: variation,
        topK: env.RAG_DEFAULT_TOP_K,
        languageHint: language,
        disableMultiQuery: true,
        documentIds,
        cacheNamespace,
      }),
    ),
  );

  return mergeCandidatePools(results.map((result) => result.chunks));
}
