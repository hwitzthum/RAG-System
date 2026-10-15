import {
  startActiveObservation,
  updateActiveObservation,
} from "@langfuse/tracing";
import { env } from "@/lib/config/env";
import { getRuntimeSecrets } from "@/lib/runtime/secrets";
import { openAiChatParams } from "@/lib/providers/openai-chat";
import type { RetrievedChunk } from "@/lib/contracts/retrieval";

export type CitationVerification = {
  /** Cited sentences submitted for verification. */
  checkedCount: number;
  supportedCount: number;
  unsupportedCount: number;
  /** True when the verifier could not run (disabled, timeout, error). */
  unverified: boolean;
};

const VERIFICATION_TIMEOUT_MS = 3_500;
const CITATION_MARKER_PATTERN = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
const LEADING_MARKERS_PATTERN = /^(?:\[\d+(?:\s*,\s*\d+)*\]\s*)+/;

const VERIFIER_SYSTEM_PROMPT = [
  "You verify citations in a retrieval-grounded answer.",
  "For EVERY claim, decide whether it is entailed by its cited evidence excerpts. Judge ONLY against the provided excerpts.",
  'Return ONLY a JSON object: {"verdicts": boolean[]} with EXACTLY one entry per claim, in order. Cover ALL claims.',
].join("\n");

export const UNVERIFIED: CitationVerification = {
  checkedCount: 0,
  supportedCount: 0,
  unsupportedCount: 0,
  unverified: true,
};

type CitedSentence = {
  sentence: string;
  chunkIndexes: number[];
};

/**
 * Splits on terminal punctuation, keeping markers placed after it ("fact. [1]",
 * gpt-6-luna's habit; gpt-4o-mini wrote "fact [1].") with the sentence they
 * close. Otherwise each marker is attributed to the next sentence and every
 * claim is verified against the wrong chunks.
 */
function splitSentences(answer: string): string[] {
  const sentences: string[] = [];
  for (const segment of answer.split(/(?<=[.!?])\s+/)) {
    const leadingMarkers = segment.match(LEADING_MARKERS_PATTERN)?.[0];
    if (leadingMarkers && sentences.length > 0) {
      sentences[sentences.length - 1] += ` ${leadingMarkers.trim()}`;
      sentences.push(segment.slice(leadingMarkers.length));
    } else {
      sentences.push(segment);
    }
  }
  return sentences;
}

function extractCitedSentences(
  answer: string,
  chunkCount: number,
): CitedSentence[] {
  return splitSentences(answer)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
    .map((sentence) => {
      const chunkIndexes = new Set<number>();
      for (const match of sentence.matchAll(CITATION_MARKER_PATTERN)) {
        for (const part of match[1]!.split(",")) {
          const index = Number.parseInt(part.trim(), 10) - 1;
          if (Number.isInteger(index) && index >= 0 && index < chunkCount) {
            chunkIndexes.add(index);
          }
        }
      }
      return { sentence, chunkIndexes: [...chunkIndexes] };
    })
    .filter((entry) => entry.chunkIndexes.length > 0);
}

/**
 * Post-generation citation check: one batched LLM call verifying that each
 * [n]-cited sentence is entailed by the chunk(s) it cites. Annotate-only —
 * the result never alters the answer; unsupported counts surface as a
 * confidence signal in the response metadata.
 */
export async function verifyCitedStatements(input: {
  answer: string;
  chunks: RetrievedChunk[];
}): Promise<CitationVerification> {
  return startActiveObservation(
    "verify-citations",
    async (observation) => {
      observation.update({ input: input.answer });

      const verification = await verifyCitedStatementsUntraced(input);

      // Typed as a generation rather than an evaluator on purpose: this is a
      // billed model call, and only generations carry model/usage/cost in
      // Langfuse. `unverified` distinguishes "the verifier failed" from "the
      // verifier ran and found nothing unsupported" — the two look identical
      // in the counts alone.
      observation.update({
        output: verification,
        metadata: {
          unsupportedShare:
            verification.checkedCount > 0
              ? verification.unsupportedCount / verification.checkedCount
              : null,
        },
      });

      return verification;
    },
    { asType: "generation" },
  );
}

async function verifyCitedStatementsUntraced(input: {
  answer: string;
  chunks: RetrievedChunk[];
}): Promise<CitationVerification> {
  const apiKey = getRuntimeSecrets().openAiApiKey ?? env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ...UNVERIFIED };
  }

  const citedSentences = extractCitedSentences(
    input.answer,
    input.chunks.length,
  );
  if (citedSentences.length === 0) {
    return {
      checkedCount: 0,
      supportedCount: 0,
      unsupportedCount: 0,
      unverified: false,
    };
  }

  const referencedChunkIndexes = [
    ...new Set(citedSentences.flatMap((entry) => entry.chunkIndexes)),
  ].sort((a, b) => a - b);

  // Each cited chunk in full: the answer was written from the whole chunk, so
  // a verifier shown only a leading excerpt (formerly 1,200 characters of
  // 3-4K) rejects every claim supported further down. Only cited chunks are
  // sent, and chunks are size-bounded at ingest, so the prompt stays small.
  const chunkBlocks = referencedChunkIndexes
    .map((index) => {
      const chunk = input.chunks[index]!;
      return `[chunk ${index + 1}]\n${chunk.sectionTitle}\n${chunk.content}`;
    })
    .join("\n\n");

  const claimLines = citedSentences
    .map(
      (entry, position) =>
        `${position + 1}. (cites chunk${entry.chunkIndexes.length > 1 ? "s" : ""} ${entry.chunkIndexes.map((i) => i + 1).join(", ")}) ${entry.sentence}`,
    )
    .join("\n");

  const chatParams = openAiChatParams({
    model: env.RAG_CITATION_VERIFIER_MODEL,
    maxCompletionTokens: 300,
  });

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(VERIFICATION_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: env.RAG_CITATION_VERIFIER_MODEL,
        ...chatParams,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: VERIFIER_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Evidence excerpts:\n${chunkBlocks}\n\nClaims (${citedSentences.length}):\n${claimLines}`,
          },
        ],
      }),
    });

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };

    // The verifier runs on its own model, separate from the answer model, so
    // its cost has to be recorded here rather than by the shared provider.
    updateActiveObservation(
      {
        model: env.RAG_CITATION_VERIFIER_MODEL,
        modelParameters: chatParams,
        ...(payload.usage
          ? {
              usageDetails: {
                input: payload.usage.prompt_tokens ?? 0,
                output: payload.usage.completion_tokens ?? 0,
              },
            }
          : {}),
      },
      { asType: "generation" },
    );

    if (!response.ok) {
      throw new Error(
        payload.error?.message ?? `verifier_http_${response.status}`,
      );
    }

    const parsed = JSON.parse(
      payload.choices?.[0]?.message?.content ?? "{}",
    ) as { verdicts?: unknown };
    const verdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts : null;

    // A verifier that dropped entries is not trusted.
    if (!verdicts || verdicts.length !== citedSentences.length) {
      return { ...UNVERIFIED };
    }

    const supportedCount = verdicts.filter(
      (verdict) => verdict === true,
    ).length;
    return {
      checkedCount: citedSentences.length,
      supportedCount,
      unsupportedCount: citedSentences.length - supportedCount,
      unverified: false,
    };
  } catch {
    return { ...UNVERIFIED };
  }
}
