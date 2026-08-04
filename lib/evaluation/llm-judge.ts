import type { RetrievedChunk } from "@/lib/contracts/retrieval";
import { env } from "@/lib/config/env";
import type { QueryJudgeMetrics } from "@/lib/evaluation/types";

export type JudgeQueryInput = {
  question: string;
  answer: string;
  insufficientEvidence: boolean;
  chunks: RetrievedChunk[];
  acceptableAnswerPoints: string[];
};

type JudgeRawResponse = {
  statements?: Array<{ text?: string; supported?: boolean }>;
  answer_relevance?: number;
  chunk_relevant?: boolean[];
  answer_points_covered?: boolean[];
};

const JUDGE_TIMEOUT_MS = 30_000;
// Bounds prompt size; a 700-word chunk fits comfortably.
const CHUNK_EXCERPT_CHARS = 1_500;

const JUDGE_SYSTEM_PROMPT = [
  "You are a strict evaluation judge for a retrieval-augmented QA system.",
  "Judge ONLY against the provided evidence chunks — not your own knowledge.",
  "Return ONLY a JSON object with EXACTLY these keys:",
  '- "statements": array covering EVERY factual claim in the answer, each as {"text": string, "supported": boolean}. "supported" is true only when the claim is entailed by at least one evidence chunk. If the answer declines to answer or contains no factual claims, return an empty array.',
  '- "answer_relevance": number 0-1. How directly the answer addresses the question. An answer that declines to answer scores 0.',
  '- "chunk_relevant": boolean array with EXACTLY one entry per evidence chunk, in order. An entry is true when that chunk contains information relevant to answering the question.',
  '- "answer_points_covered": boolean array with EXACTLY one entry per expected answer point, in order. An entry is true when the information of that point is present somewhere in the evidence chunks.',
  "Cover ALL statements, ALL chunks, and ALL answer points. Never omit array entries.",
].join("\n");

function clampUnit(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  return Math.min(1, Math.max(0, value));
}

function buildJudgeUserPrompt(input: JudgeQueryInput): string {
  const chunkBlocks = input.chunks
    .map((chunk, index) => {
      const excerpt = `${chunk.sectionTitle}\n${chunk.content}`.slice(
        0,
        CHUNK_EXCERPT_CHARS,
      );
      return `[chunk ${index + 1}]\n${excerpt}`;
    })
    .join("\n\n");

  const pointLines = input.acceptableAnswerPoints
    .map((point, index) => `${index + 1}. ${point}`)
    .join("\n");

  return [
    `Question:\n${input.question}`,
    `System answer:\n${input.answer}`,
    `Evidence chunks (${input.chunks.length}):\n${chunkBlocks || "(none)"}`,
    `Expected answer points (${input.acceptableAnswerPoints.length}):\n${pointLines}`,
  ].join("\n\n");
}

function fractionOf(
  values: boolean[] | undefined,
  expectedLength: number,
): number | null {
  if (!Array.isArray(values) || expectedLength === 0) {
    return null;
  }
  // A judge that dropped entries is not trusted for this dimension.
  if (values.length !== expectedLength) {
    return null;
  }
  return values.filter(Boolean).length / expectedLength;
}

const UNJUDGED: QueryJudgeMetrics = {
  judged: false,
  faithfulness: null,
  answerRelevance: null,
  contextPrecision: null,
  contextRecall: null,
  abstained: false,
  unsupportedStatementCount: null,
};

/**
 * One batched judge call per query: statement-level faithfulness, answer
 * relevance, per-chunk context precision, and answer-point context recall.
 *
 * Abstentions are NOT auto-scored as perfectly grounded (the flaw of the
 * token-overlap metric): an abstention makes no claims (faithfulness 1) but
 * scores 0 on answer relevance and is flagged via `abstained`, so a system
 * that refuses answerable questions cannot look flawless.
 */
export async function judgeQueryResult(
  input: JudgeQueryInput,
): Promise<QueryJudgeMetrics> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ...UNJUDGED };
  }

  let raw: JudgeRawResponse;
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: env.RAG_EVAL_JUDGE_MODEL,
        temperature: 0,
        max_tokens: 1500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: JUDGE_SYSTEM_PROMPT },
          { role: "user", content: buildJudgeUserPrompt(input) },
        ],
      }),
    });

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new Error(
        payload.error?.message ?? `judge_http_${response.status}`,
      );
    }

    raw = JSON.parse(
      payload.choices?.[0]?.message?.content ?? "{}",
    ) as JudgeRawResponse;
  } catch {
    return { ...UNJUDGED };
  }

  const abstained = input.insufficientEvidence;

  const statements = Array.isArray(raw.statements) ? raw.statements : [];
  const supportedCount = statements.filter(
    (statement) => statement?.supported === true,
  ).length;
  // No factual claims (including abstentions) means nothing was hallucinated.
  const faithfulness =
    statements.length === 0 ? 1 : supportedCount / statements.length;

  const answerRelevance = abstained ? 0 : clampUnit(raw.answer_relevance);

  return {
    judged: true,
    faithfulness,
    answerRelevance,
    contextPrecision: fractionOf(raw.chunk_relevant, input.chunks.length),
    contextRecall: fractionOf(
      raw.answer_points_covered,
      input.acceptableAnswerPoints.length,
    ),
    abstained,
    unsupportedStatementCount: statements.length - supportedCount,
  };
}
