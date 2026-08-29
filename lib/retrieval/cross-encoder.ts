import { startActiveObservation } from "@langfuse/tracing";
import type { RetrievedChunk } from "@/lib/contracts/retrieval";
import { CohereClient } from "cohere-ai";
import { env } from "@/lib/config/env";
import { summarizeChunks } from "@/lib/observability/trace-payloads";
import { getRuntimeSecrets } from "@/lib/runtime/secrets";

export type CrossEncoderInput = {
  query: string;
  chunks: RetrievedChunk[];
  model: string;
};

// Cohere accepts up to 1,000 documents per rerank call; capping well below
// that bounds cost and latency.
//
// RAG_RERANK_POOL_SIZE now defaults to 100, so this cap is exactly binding
// rather than the comfortable headroom it used to be: raise the pool above 100
// and the excess silently keeps its heuristic order behind the cross-encoded
// candidates (see the overflow handling below) instead of being reranked.
// Raise this constant in step if the pool is ever taken higher.
const CROSS_ENCODER_POOL_CAP = 100;

const CE_DOCUMENT_CHAR_CAP = 4096;

/**
 * Text the cross-encoder scores for one chunk: section title plus content.
 * The contextual-retrieval paragraph is deliberately NOT included — the Wave 4
 * A/B measured it net-negative for ranking quality.
 */
export function buildCrossEncoderDocument(chunk: RetrievedChunk): string {
  return `${chunk.sectionTitle}\n${chunk.content}`.slice(
    0,
    CE_DOCUMENT_CHAR_CAP,
  );
}

/**
 * Reranks the full candidate pool with Cohere's cross-encoder and returns the
 * full pool in cross-encoded order. Deliberately does NOT truncate to topK:
 * the caller slices after contextual grouping, so a candidate ranked anywhere
 * in the pool can still reach the final set. On any failure (no key, timeout,
 * API error) the input order is returned unchanged so the heuristic ranking
 * stays in effect.
 */
export async function crossEncoderRerank(
  input: CrossEncoderInput,
): Promise<RetrievedChunk[]> {
  if (input.chunks.length === 0) {
    return [];
  }

  return startActiveObservation(
    "rerank-cross-encoder",
    async (observation) => {
      observation.update({
        input: { query: input.query, ...summarizeChunks(input.chunks) },
        metadata: {
          model: input.model,
          poolCap: CROSS_ENCODER_POOL_CAP,
        },
      });

      const reranked = await crossEncoderRerankUntraced(input);

      // This stage fails soft — no key, a timeout, or an API error all return
      // the input order untouched. Without this flag a silent fallback is
      // indistinguishable in the trace from a rerank that changed nothing.
      observation.update({
        output: summarizeChunks(reranked),
        metadata: {
          applied: reranked !== input.chunks,
          scoreScale: reranked[0]?.scoreScale ?? null,
        },
      });

      return reranked;
    },
    { asType: "tool" },
  );
}

async function crossEncoderRerankUntraced(
  input: CrossEncoderInput,
): Promise<RetrievedChunk[]> {
  const runtimeCohereApiKey = getRuntimeSecrets().cohereApiKey;
  const apiKey = runtimeCohereApiKey ?? env.COHERE_API_KEY;

  if (!apiKey) {
    return input.chunks;
  }

  const cappedChunks = input.chunks.slice(0, CROSS_ENCODER_POOL_CAP);
  const overflowChunks = input.chunks.slice(CROSS_ENCODER_POOL_CAP);

  const documents = cappedChunks.map(buildCrossEncoderDocument);

  try {
    const cohere = new CohereClient({ token: apiKey });

    const timeoutMs = env.RAG_CROSS_ENCODER_TIMEOUT_MS;
    const response = await cohere.v2.rerank(
      {
        model: input.model,
        query: input.query,
        documents,
        topN: documents.length,
      },
      {
        timeoutInSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(timeoutMs),
      },
    );

    // Cohere's relevanceScore is already an absolute query-document relevance
    // measure, so it serves as both the ordering score and the gate score. The
    // scale marker tells lib/answering/policy.ts which threshold applies —
    // these numbers are not comparable with the heuristic reranker's.
    const reranked = response.results.map((result) => ({
      ...cappedChunks[result.index]!,
      rerankScore: result.relevanceScore,
      relevanceScore: result.relevanceScore,
      scoreScale: "cross_encoder" as const,
    }));

    // Chunks beyond the cap keep their heuristic order and scores, behind the
    // cross-encoded ones.
    return [...reranked, ...overflowChunks];
  } catch (error) {
    console.warn(
      "Cohere rerank failed, falling back to heuristic order:",
      error,
    );
    return input.chunks;
  }
}
