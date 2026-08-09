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

/**
 * Second retrieval pass for the CRAG loop's ambiguous band: rephrase the
 * query, retrieve for the original plus each variation, and merge. Each
 * branch disables multi-query expansion — the variations ARE the branches,
 * and expanding them again would cost branches x variations embedding calls.
 */
export async function correctiveRetrieve(
  query: string,
  language: SupportedLanguage,
): Promise<RetrievedChunk[]> {
  return startActiveObservation(
    "corrective-retrieve",
    async (observation) => {
      observation.update({ input: { query, language } });
      const chunks = await correctiveRetrieveUntraced(query, language);
      observation.update({ output: summarizeChunks(chunks) });
      return chunks;
    },
    { asType: "span" },
  );
}

async function correctiveRetrieveUntraced(
  query: string,
  language: SupportedLanguage,
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
      }),
    ),
  );

  return mergeCandidatePools(results.map((result) => result.chunks));
}
