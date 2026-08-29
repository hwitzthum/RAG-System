import { startActiveObservation } from "@langfuse/tracing";
import type {
  Citation,
  RetrievedChunk,
  SupportedLanguage,
} from "@/lib/contracts/retrieval";
import { env } from "@/lib/config/env";
import { summarizeChunks } from "@/lib/observability/trace-payloads";
import { unsupportedPremiseMessage } from "@/lib/answering/premise";
import {
  assessEvidence,
  hasSufficientEvidence,
  selectChunkIndexesMeetingThreshold,
  type EvidenceAssessment,
  type EvidenceScaleComposition,
  type EvidenceVerdict,
} from "@/lib/answering/policy";
import { checkEntityGrounding } from "@/lib/answering/entity-terms";
import { resolveCitedChunks } from "@/lib/answering/citations";
import { orderEvidenceIndexes } from "@/lib/answering/evidence-order";
import {
  verifyCitedStatements,
  type CitationVerification,
} from "@/lib/answering/verification";
import {
  collectEvidenceEmails,
  redactStreamedSentence,
  type PiiRedactionOptions,
} from "@/lib/security/output-filter";
import {
  answerBeginsWithAbstentionToken,
  buildGroundedAnswerVariables,
  GROUNDED_ANSWER_SYSTEM_PROMPT,
  GROUNDED_ANSWER_USER_TEMPLATE,
  INSUFFICIENT_EVIDENCE_MESSAGE,
  INSUFFICIENT_EVIDENCE_TOKEN,
} from "@/lib/answering/prompts";
import {
  buildWebAugmentedVariables,
  WEB_AUGMENTED_SYSTEM_PROMPT,
  WEB_AUGMENTED_USER_TEMPLATE,
} from "@/lib/answering/web-augmented-prompts";
import {
  GROUNDED_ANSWER_PROMPT_NAME,
  resolveAnswerPrompt,
  WEB_AUGMENTED_PROMPT_NAME,
  type ResolvedPrompt,
} from "@/lib/answering/prompt-registry";
import { getDefaultProviders } from "@/lib/providers/defaults";
import type { LlmProvider } from "@/lib/providers/types";
import { filterAnswerOutput } from "@/lib/security/output-filter";
import {
  containsSensitiveLeakage,
  protectRetrievedChunks,
  protectWebSources,
} from "@/lib/security/prompt-injection";
import type { WebSource } from "@/lib/web-research/types";

export type GenerateGroundedAnswerInput = {
  query: string;
  language: SupportedLanguage;
  chunks: RetrievedChunk[];
  minEvidenceChunks: number;
  minRerankScore: number;
  minHeuristicRelevance: number;
  maxOutputTokens: number;
  documentScopeId?: string | null;
  /**
   * A name the question presupposes that appears nowhere in the caller's
   * corpus, from `findUnsupportedPremise`. Set means refuse before generating:
   * the evidence may be perfectly relevant to the topic, but answering would
   * attribute it to a source that does not exist. Resolved in the route, which
   * owns document scoping — this module stays pure over its inputs.
   */
  unsupportedPremiseEntity?: string | null;
  /**
   * When provided (and the LLM provider supports streaming), completed,
   * per-sentence-redacted sentences are emitted as they are generated. The
   * returned result remains authoritative: its answer has passed the full
   * output filter and may differ from (or retract) the streamed text.
   */
  onSentence?: (sentence: string) => void;
};

export type GenerateGroundedAnswerResult = {
  answer: string;
  citations: Citation[];
  insufficientEvidence: boolean;
  promptInjection: {
    suspiciousChunkCount: number;
    blockedChunkCount: number;
    suspiciousWebSourceCount: number;
    blockedWebSourceCount: number;
    blockedUserQuery: boolean;
  };
  outputFilter: {
    blocked: boolean;
    filtered: boolean;
    reasons: string[];
    redactionCount: number;
  };
  citationAttribution: {
    /** Distinct in-range [n] markers resolved from the answer. */
    markerCount: number;
    /** Markers referencing an evidence index that does not exist. */
    invalidMarkerCount: number;
    /** True when the model wrote no usable marker and all chunks were returned. */
    fellBack: boolean;
  };
  /** Annotate-only citation check; null when disabled or not applicable. */
  citationVerification: CitationVerification | null;
  /**
   * The model hit RAG_LLM_MAX_OUTPUT_TOKENS mid-answer. Non-zero in a
   * benchmark run is a configuration bug, not a quality signal.
   */
  answerTruncated: boolean;
  /**
   * The CRAG loop's three-way evidence read, populated on every grounded
   * result including refusals. Always recorded — with the loop disabled the
   * verdict is observability only and `ambiguous` behaves exactly like
   * `sufficient`. The web-augmented path records the assessment with no
   * band actions.
   */
  evidenceAssessment: {
    verdict: EvidenceVerdict;
    top1Relevance: number | null;
    top3MeanRelevance: number | null;
    scale: EvidenceScaleComposition;
    actionsTaken: string[];
    loopEnabled: boolean;
  } | null;
};

export type AnswerServiceDependencies = {
  llmProvider: LlmProvider;
  /** Injectable citation verifier; defaults to verifyCitedStatements. */
  verifyCitations: typeof verifyCitedStatements;
};

// Used for the early-return paths (insufficient evidence, leakage, blocked
// output) where there is no model answer to attribute against.
const UNATTRIBUTED: GenerateGroundedAnswerResult["citationAttribution"] = {
  markerCount: 0,
  invalidMarkerCount: 0,
  fellBack: false,
};

function buildCitations(chunks: RetrievedChunk[]): Citation[] {
  return chunks.map((chunk) => ({
    documentId: chunk.documentId,
    pageNumber: chunk.pageNumber,
    chunkId: chunk.chunkId,
  }));
}

function uniqueCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const output: Citation[] = [];

  for (const citation of citations) {
    const key = `${citation.documentId}:${citation.pageNumber}:${citation.chunkId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(citation);
  }

  return output;
}

const SENTENCE_BOUNDARY_PATTERN = /^[\s\S]*?[.!?][)"'»\]]*\s+/;

/**
 * Did the model take the abstention path the prompt gives it?
 *
 * Matched on the whole answer rather than searched for, so an answer that
 * merely *discusses* insufficient evidence is not mistaken for a refusal.
 * Trailing punctuation and surrounding whitespace or code fences are tolerated
 * because small models add them; anything more substantial than that is a real
 * answer and is treated as one.
 */
function isModelAbstention(answer: string): boolean {
  const stripped = answer
    .trim()
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/[.!?*_\s]+$/g, "")
    .trim();

  return stripped === INSUFFICIENT_EVIDENCE_TOKEN;
}

/**
 * Generates the answer, streaming per-sentence when both a callback and a
 * streaming-capable provider are available. Each completed sentence passes
 * per-sentence redaction before emission; a prompt-leak signature halts
 * further emission (the caller's final, fully-filtered result retracts).
 * Always resolves with the complete raw answer text.
 */
async function generateAnswerText(
  llmProvider: AnswerServiceDependencies["llmProvider"],
  input: {
    systemPrompt: string;
    userPrompt: string;
    language: SupportedLanguage;
    maxOutputTokens: number;
    pii: PiiRedactionOptions;
    onSentence?: (sentence: string) => void;
    /** Managed prompt behind this call; null when the fallback was used. */
    prompt?: ResolvedPrompt["prompt"];
  },
): Promise<{ text: string; truncated: boolean }> {
  return startActiveObservation(
    "write-answer",
    async (observation) => {
      // Role-labelled messages so Langfuse renders a readable conversation
      // rather than a JSON blob. This is the prompt the model actually saw,
      // including the assembled evidence.
      observation.update({
        input: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userPrompt },
        ],
        // Linking the managed prompt is what makes metrics comparable across
        // prompt versions. `promptManaged: false` marks answers produced from
        // the in-code fallback, which must not be attributed to any version.
        ...(input.prompt ? { prompt: input.prompt } : {}),
        metadata: {
          language: input.language,
          promptManaged: Boolean(input.prompt),
          streamed: Boolean(
            input.onSentence && llmProvider.generateAnswerStream,
          ),
        },
      });

      const generated = await generateAnswerTextUntraced(llmProvider, input);

      // Model, token usage and TTFT are attached by the provider layer
      // (lib/providers/defaults.ts) onto this same observation.
      observation.update({
        output: generated.text,
        metadata: { truncated: generated.truncated },
      });

      return generated;
    },
    { asType: "generation" },
  );
}

async function generateAnswerTextUntraced(
  llmProvider: AnswerServiceDependencies["llmProvider"],
  input: {
    systemPrompt: string;
    userPrompt: string;
    language: SupportedLanguage;
    maxOutputTokens: number;
    pii: PiiRedactionOptions;
    onSentence?: (sentence: string) => void;
  },
): Promise<{ text: string; truncated: boolean }> {
  const { onSentence } = input;
  if (!onSentence || !llmProvider.generateAnswerStream) {
    return llmProvider.generateAnswer({
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      language: input.language,
      maxOutputTokens: input.maxOutputTokens,
    });
  }

  let pending = "";
  let halted = false;

  const emitSentence = (sentence: string) => {
    if (halted) {
      return;
    }
    const redacted = redactStreamedSentence(sentence, input.pii);
    if (redacted.halted) {
      halted = true;
      return;
    }
    if (redacted.text.trim()) {
      onSentence(redacted.text);
    }
  };

  const generated = await llmProvider.generateAnswerStream(
    {
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      language: input.language,
      maxOutputTokens: input.maxOutputTokens,
    },
    (delta) => {
      pending += delta;
      let match: RegExpMatchArray | null;
      while ((match = pending.match(SENTENCE_BOUNDARY_PATTERN))) {
        const sentence = match[0];
        pending = pending.slice(sentence.length);
        emitSentence(sentence);
      }
    },
  );

  if (pending.trim()) {
    emitSentence(pending);
  }

  return generated;
}

/**
 * Trace metadata shared by both answer paths. These fields are the ones a
 * reviewer needs to judge a refusal at a glance: whether the evidence gate or
 * the model itself declined, and which CRAG actions fired.
 */
function answerObservationMetadata(
  result: GenerateGroundedAnswerResult,
): Record<string, unknown> {
  return {
    insufficientEvidence: result.insufficientEvidence,
    answerTruncated: result.answerTruncated,
    evidenceAssessment: result.evidenceAssessment,
    promptInjection: result.promptInjection,
    outputFilter: result.outputFilter,
    citationAttribution: result.citationAttribution,
    citationVerification: result.citationVerification,
    citationCount: result.citations.length,
  };
}

export async function generateGroundedAnswer(
  input: GenerateGroundedAnswerInput,
  overrides: Partial<AnswerServiceDependencies> = {},
): Promise<GenerateGroundedAnswerResult> {
  return startActiveObservation(
    "generate-answer",
    async (observation) => {
      observation.update({
        input: { query: input.query, ...summarizeChunks(input.chunks) },
        metadata: { mode: "grounded", language: input.language },
      });

      const result = await generateGroundedAnswerUntraced(input, overrides);

      observation.update({
        output: result.answer,
        metadata: { mode: "grounded", ...answerObservationMetadata(result) },
      });

      return result;
    },
    { asType: "span" },
  );
}

async function generateGroundedAnswerUntraced(
  input: GenerateGroundedAnswerInput,
  overrides: Partial<AnswerServiceDependencies> = {},
): Promise<GenerateGroundedAnswerResult> {
  const llmProvider = overrides.llmProvider ?? getDefaultProviders().llm;
  const verifyCitations = overrides.verifyCitations ?? verifyCitedStatements;

  const rawChunks = input.chunks;
  const protectedChunks = protectRetrievedChunks(rawChunks);
  const citations = uniqueCitations(buildCitations(rawChunks));

  const loopEnabled = env.RAG_CRAG_LOOP_ENABLED;
  const actionsTaken: string[] = [];
  const assess = (chunks: RetrievedChunk[]): EvidenceAssessment =>
    assessEvidence({
      chunks,
      minEvidenceChunks: input.minEvidenceChunks,
      minRerankScore: input.minRerankScore,
      minHeuristicRelevance: input.minHeuristicRelevance,
      documentScoped: Boolean(input.documentScopeId),
      sufficientTop3Mean: env.RAG_EVIDENCE_SUFFICIENT_TOP3_MEAN,
      sufficientTop3MeanHeuristic:
        env.RAG_EVIDENCE_SUFFICIENT_TOP3_MEAN_HEURISTIC,
    });

  const assessment = assess(protectedChunks.chunks);
  // Snapshot at return time so late-pushed actions are never lost.
  const evidenceAssessmentResult = (): NonNullable<
    GenerateGroundedAnswerResult["evidenceAssessment"]
  > => ({
    verdict: assessment.verdict,
    top1Relevance: assessment.top1Relevance,
    top3MeanRelevance: assessment.top3MeanRelevance,
    scale: assessment.scale,
    actionsTaken: [...actionsTaken],
    loopEnabled,
  });

  const insufficientRefusal = (
    reasons: string[],
    answerTruncated: boolean,
    citationVerification: CitationVerification | null = null,
  ): GenerateGroundedAnswerResult => ({
    answer: INSUFFICIENT_EVIDENCE_MESSAGE,
    citations: citations.slice(0, 3),
    insufficientEvidence: true,
    answerTruncated,
    promptInjection: {
      suspiciousChunkCount: protectedChunks.suspiciousCount,
      blockedChunkCount: protectedChunks.blockedCount,
      suspiciousWebSourceCount: 0,
      blockedWebSourceCount: 0,
      blockedUserQuery: false,
    },
    outputFilter: {
      blocked: false,
      filtered: false,
      reasons,
      redactionCount: 0,
    },
    citationAttribution: UNATTRIBUTED,
    citationVerification,
    evidenceAssessment: evidenceAssessmentResult(),
  });

  if (input.unsupportedPremiseEntity) {
    return {
      ...insufficientRefusal([], false),
      answer: unsupportedPremiseMessage(input.unsupportedPremiseEntity),
    };
  }

  if (assessment.verdict === "insufficient") {
    return insufficientRefusal([], false);
  }

  // With the loop off, `ambiguous` behaves exactly like `sufficient`: the
  // assessment above is observability only, and everything below is
  // bit-identical to the pre-loop behavior.
  const ambiguousBand = loopEnabled && assessment.verdict === "ambiguous";

  let evidenceCaution: { missingTerms: string[] } | undefined;
  if (ambiguousBand && env.RAG_CRAG_PROMPT_GUARD_ENABLED) {
    // Checked against the sanitized chunks — the evidence the model will
    // actually see. Only the action string travels into the assessment
    // metadata; the terms themselves stay in the prompt.
    const grounding = checkEntityGrounding({
      query: input.query,
      language: input.language,
      chunks: protectedChunks.chunks,
    });
    evidenceCaution = { missingTerms: grounding.missingTerms };
    actionsTaken.push("prompt_guard");
  }

  // Evidence placement happens AFTER the gate (which reads score order) and
  // applies the same permutation to the sanitized prompt chunks and the raw
  // attribution chunks, so [n] markers keep resolving to the right chunk.
  const evidenceOrder = orderEvidenceIndexes(protectedChunks.chunks);
  const promptChunks = evidenceOrder.map(
    (index) => protectedChunks.chunks[index]!,
  );
  const attributionChunks = evidenceOrder.map((index) => rawChunks[index]!);

  const resolvedPrompt = await resolveAnswerPrompt({
    name: GROUNDED_ANSWER_PROMPT_NAME,
    fallback: [
      { role: "system", content: GROUNDED_ANSWER_SYSTEM_PROMPT },
      { role: "user", content: GROUNDED_ANSWER_USER_TEMPLATE },
    ],
    variables: buildGroundedAnswerVariables({
      query: input.query,
      language: input.language,
      chunks: promptChunks,
      evidenceCaution,
    }),
  });

  // Addresses the caller's own RBAC-scoped evidence already contains are not
  // a leak, so they survive redaction. Computed from the raw attribution
  // chunks, not the sanitized prompt copies.
  const pii: PiiRedactionOptions = {
    mode: env.RAG_PII_REDACTION,
    evidenceEmails: collectEvidenceEmails(attributionChunks),
  };

  const generated = await generateAnswerText(llmProvider, {
    systemPrompt: resolvedPrompt.systemPrompt,
    userPrompt: resolvedPrompt.userPrompt,
    language: input.language,
    maxOutputTokens: input.maxOutputTokens,
    pii,
    onSentence: input.onSentence,
    prompt: resolvedPrompt.prompt,
  });
  const answer = generated.text;

  // The model took the prompt's abstention path. Give it the same structured
  // treatment the score gate gets, and strip the token before it can reach a
  // user — resolveCitedChunks and the output filter would otherwise pass the
  // bare sentinel straight through as the answer text.
  if (isModelAbstention(answer)) {
    return insufficientRefusal(["model_abstention"], generated.truncated);
  }

  // Ambiguous band only: the prompt guard makes some models emit the token
  // and then keep explaining. A token-prefixed answer is still an abstention
  // and gets the same structured refusal.
  if (ambiguousBand && answerBeginsWithAbstentionToken(answer)) {
    actionsTaken.push("model_abstention_prefix");
    return insufficientRefusal(
      ["model_abstention_prefix"],
      generated.truncated,
    );
  }

  if (containsSensitiveLeakage(answer)) {
    return {
      answer: INSUFFICIENT_EVIDENCE_MESSAGE,
      citations: citations.slice(0, 3),
      insufficientEvidence: true,
      answerTruncated: false,
      promptInjection: {
        suspiciousChunkCount: protectedChunks.suspiciousCount,
        blockedChunkCount: protectedChunks.blockedCount,
        suspiciousWebSourceCount: 0,
        blockedWebSourceCount: 0,
        blockedUserQuery: false,
      },
      outputFilter: {
        blocked: true,
        filtered: true,
        reasons: ["sensitive_leakage"],
        redactionCount: 0,
      },
      citationAttribution: UNATTRIBUTED,
      citationVerification: null,
      evidenceAssessment: evidenceAssessmentResult(),
    };
  }

  // Attribute before filtering: the marker indices refer to the model's own
  // output, and filterAnswerOutput may redact spans but never renumbers them.
  // Attribution also returns the answer with dangling markers removed, so the
  // filter (and everything downstream) works on the text the user will read.
  const attribution = resolveCitedChunks({ answer, chunks: attributionChunks });

  const filteredOutput = filterAnswerOutput({
    answer: attribution.answer,
    citations: attribution.citations,
    language: input.language,
    pii,
  });

  const citationVerification =
    env.RAG_CITATION_VERIFICATION_ENABLED && !filteredOutput.blocked
      ? await verifyCitations({
          answer: filteredOutput.answer,
          chunks: attributionChunks,
        })
      : null;

  // Self-RAG reflection, ambiguous band only: when the verifier actually ran
  // over a large enough sample and judged too great a share of the cited
  // sentences unsupported, the answer is retracted rather than annotated.
  // The verification travels with the refusal so the retraction is auditable.
  if (
    ambiguousBand &&
    env.RAG_CRAG_REFLECTION_ENABLED &&
    citationVerification &&
    !citationVerification.unverified &&
    citationVerification.checkedCount >= env.RAG_CRAG_REFLECTION_MIN_CHECKED &&
    citationVerification.unsupportedCount / citationVerification.checkedCount >=
      env.RAG_CRAG_REFLECTION_MAX_UNSUPPORTED_SHARE
  ) {
    actionsTaken.push("reflection_unsupported_citations");
    return insufficientRefusal(
      ["reflection_unsupported_citations"],
      generated.truncated,
      citationVerification,
    );
  }

  return {
    answer: filteredOutput.answer,
    citations: filteredOutput.citations,
    insufficientEvidence: filteredOutput.blocked ? true : false,
    answerTruncated: generated.truncated,
    promptInjection: {
      suspiciousChunkCount: protectedChunks.suspiciousCount,
      blockedChunkCount: protectedChunks.blockedCount,
      suspiciousWebSourceCount: 0,
      blockedWebSourceCount: 0,
      blockedUserQuery: false,
    },
    outputFilter: {
      blocked: filteredOutput.blocked,
      filtered: filteredOutput.filtered,
      reasons: filteredOutput.reasons,
      redactionCount: filteredOutput.redactionCount,
    },
    citationAttribution: {
      markerCount: attribution.markerCount,
      invalidMarkerCount: attribution.invalidMarkerCount,
      fellBack: attribution.fellBack,
    },
    citationVerification,
    evidenceAssessment: evidenceAssessmentResult(),
  };
}

export type GenerateWebAugmentedAnswerInput = GenerateGroundedAnswerInput & {
  webSources: WebSource[];
  /**
   * Minimum number of web sources required before the answer may proceed
   * without sufficient local document evidence. A single stray web hit must
   * not bypass the evidence gate.
   */
  minWebSources?: number;
};

export async function generateWebAugmentedAnswer(
  input: GenerateWebAugmentedAnswerInput,
  overrides: Partial<AnswerServiceDependencies> = {},
): Promise<GenerateGroundedAnswerResult> {
  return startActiveObservation(
    "generate-answer",
    async (observation) => {
      observation.update({
        input: {
          query: input.query,
          ...summarizeChunks(input.chunks),
          webSourceCount: input.webSources.length,
        },
        metadata: { mode: "web_augmented", language: input.language },
      });

      const result = await generateWebAugmentedAnswerUntraced(input, overrides);

      observation.update({
        output: result.answer,
        metadata: {
          mode: "web_augmented",
          ...answerObservationMetadata(result),
        },
      });

      return result;
    },
    { asType: "span" },
  );
}

async function generateWebAugmentedAnswerUntraced(
  input: GenerateWebAugmentedAnswerInput,
  overrides: Partial<AnswerServiceDependencies> = {},
): Promise<GenerateGroundedAnswerResult> {
  const llmProvider = overrides.llmProvider ?? getDefaultProviders().llm;
  const verifyCitations = overrides.verifyCitations ?? verifyCitedStatements;
  const protectedChunks = protectRetrievedChunks(input.chunks);
  const protectedWebSources = protectWebSources(input.webSources);

  const citations = uniqueCitations(buildCitations(input.chunks));
  const sufficientEvidence = hasSufficientEvidence({
    chunks: protectedChunks.chunks,
    minEvidenceChunks: input.minEvidenceChunks,
    minRerankScore: input.minRerankScore,
    minHeuristicRelevance: input.minHeuristicRelevance,
    documentScoped: Boolean(input.documentScopeId),
  });

  // Recorded for observability only: the web path takes no band actions —
  // web evidence already has its own gate (minWebSources) below.
  const assessment = assessEvidence({
    chunks: protectedChunks.chunks,
    minEvidenceChunks: input.minEvidenceChunks,
    minRerankScore: input.minRerankScore,
    minHeuristicRelevance: input.minHeuristicRelevance,
    documentScoped: Boolean(input.documentScopeId),
    sufficientTop3Mean: env.RAG_EVIDENCE_SUFFICIENT_TOP3_MEAN,
    sufficientTop3MeanHeuristic:
      env.RAG_EVIDENCE_SUFFICIENT_TOP3_MEAN_HEURISTIC,
  });
  const evidenceAssessment: GenerateGroundedAnswerResult["evidenceAssessment"] =
    {
      verdict: assessment.verdict,
      top1Relevance: assessment.top1Relevance,
      top3MeanRelevance: assessment.top3MeanRelevance,
      scale: assessment.scale,
      actionsTaken: [],
      loopEnabled: env.RAG_CRAG_LOOP_ENABLED,
    };

  const minWebSources = Math.max(1, input.minWebSources ?? 2);
  if (
    !sufficientEvidence &&
    protectedWebSources.webSources.length < minWebSources
  ) {
    return {
      answer: INSUFFICIENT_EVIDENCE_MESSAGE,
      citations: citations.slice(0, 3),
      insufficientEvidence: true,
      answerTruncated: false,
      promptInjection: {
        suspiciousChunkCount: protectedChunks.suspiciousCount,
        blockedChunkCount: protectedChunks.blockedCount,
        suspiciousWebSourceCount: protectedWebSources.suspiciousCount,
        blockedWebSourceCount: protectedWebSources.blockedCount,
        blockedUserQuery: false,
      },
      outputFilter: {
        blocked: false,
        filtered: false,
        reasons: [],
        redactionCount: 0,
      },
      citationAttribution: UNATTRIBUTED,
      citationVerification: null,
      evidenceAssessment,
    };
  }

  /*
   * The web path refuses on an unsupported premise too. Web research widens
   * the evidence but does not make the named source exist, and leaving this
   * out would turn "enable web research" into a way around the gate.
   */
  if (input.unsupportedPremiseEntity) {
    return {
      answer: unsupportedPremiseMessage(input.unsupportedPremiseEntity),
      citations: citations.slice(0, 3),
      insufficientEvidence: true,
      answerTruncated: false,
      promptInjection: {
        suspiciousChunkCount: protectedChunks.suspiciousCount,
        blockedChunkCount: protectedChunks.blockedCount,
        suspiciousWebSourceCount: protectedWebSources.suspiciousCount,
        blockedWebSourceCount: protectedWebSources.blockedCount,
        blockedUserQuery: false,
      },
      outputFilter: {
        blocked: false,
        filtered: false,
        reasons: [],
        redactionCount: 0,
      },
      citationAttribution: UNATTRIBUTED,
      citationVerification: null,
      evidenceAssessment,
    };
  }

  // When the answer proceeds on web evidence alone, sub-threshold document
  // chunks are dropped from the prompt: text that failed the evidence gate
  // must not appear as citable "PRIMARY" evidence. The same indexes filter
  // the attribution list so [n] markers keep resolving to the right chunks.
  let promptChunks = protectedChunks.chunks;
  let attributionChunks = input.chunks;
  if (!sufficientEvidence) {
    const keptIndexes = selectChunkIndexesMeetingThreshold({
      chunks: protectedChunks.chunks,
      minEvidenceChunks: input.minEvidenceChunks,
      minRerankScore: input.minRerankScore,
      minHeuristicRelevance: input.minHeuristicRelevance,
    });
    promptChunks = keptIndexes.map((index) => protectedChunks.chunks[index]!);
    attributionChunks = keptIndexes.map((index) => input.chunks[index]!);
  }

  // Ends-first evidence placement, applied to both parallel arrays.
  const evidenceOrder = orderEvidenceIndexes(promptChunks);
  promptChunks = evidenceOrder.map((index) => promptChunks[index]!);
  attributionChunks = evidenceOrder.map((index) => attributionChunks[index]!);

  const resolvedPrompt = await resolveAnswerPrompt({
    name: WEB_AUGMENTED_PROMPT_NAME,
    fallback: [
      { role: "system", content: WEB_AUGMENTED_SYSTEM_PROMPT },
      { role: "user", content: WEB_AUGMENTED_USER_TEMPLATE },
    ],
    variables: buildWebAugmentedVariables({
      query: input.query,
      language: input.language,
      chunks: promptChunks,
      webSources: protectedWebSources.webSources,
    }),
  });

  // Only document evidence exempts an address. Web snippets are third-party
  // text outside the caller's RBAC scope, so an address that appears only
  // there is still redacted.
  const pii: PiiRedactionOptions = {
    mode: env.RAG_PII_REDACTION,
    evidenceEmails: collectEvidenceEmails(attributionChunks),
  };

  const generated = await generateAnswerText(llmProvider, {
    systemPrompt: resolvedPrompt.systemPrompt,
    userPrompt: resolvedPrompt.userPrompt,
    prompt: resolvedPrompt.prompt,
    language: input.language,
    maxOutputTokens: input.maxOutputTokens,
    pii,
    onSentence: input.onSentence,
  });
  const answer = generated.text;

  // The model took the prompt's abstention path. Give it the same structured
  // treatment the score gate gets, and strip the token before it can reach a
  // user — resolveCitedChunks and the output filter would otherwise pass the
  // bare sentinel straight through as the answer text.
  if (isModelAbstention(answer)) {
    return {
      answer: INSUFFICIENT_EVIDENCE_MESSAGE,
      citations: citations.slice(0, 3),
      insufficientEvidence: true,
      answerTruncated: generated.truncated,
      promptInjection: {
        suspiciousChunkCount: protectedChunks.suspiciousCount,
        blockedChunkCount: protectedChunks.blockedCount,
        suspiciousWebSourceCount: protectedWebSources.suspiciousCount,
        blockedWebSourceCount: protectedWebSources.blockedCount,
        blockedUserQuery: false,
      },
      outputFilter: {
        blocked: false,
        filtered: false,
        reasons: ["model_abstention"],
        redactionCount: 0,
      },
      citationAttribution: UNATTRIBUTED,
      citationVerification: null,
      evidenceAssessment,
    };
  }

  if (containsSensitiveLeakage(answer)) {
    return {
      answer: INSUFFICIENT_EVIDENCE_MESSAGE,
      citations: citations.slice(0, 3),
      insufficientEvidence: true,
      answerTruncated: false,
      promptInjection: {
        suspiciousChunkCount: protectedChunks.suspiciousCount,
        blockedChunkCount: protectedChunks.blockedCount,
        suspiciousWebSourceCount: protectedWebSources.suspiciousCount,
        blockedWebSourceCount: protectedWebSources.blockedCount,
        blockedUserQuery: false,
      },
      outputFilter: {
        blocked: true,
        filtered: true,
        reasons: ["sensitive_leakage"],
        redactionCount: 0,
      },
      citationAttribution: UNATTRIBUTED,
      citationVerification: null,
      evidenceAssessment,
    };
  }

  // Only the [n] document markers are resolved here. Web sources are marked
  // [WEB-n] by buildWebAugmentedUserPrompt and travel back to the client as
  // `webSources`, not as citations.
  const attribution = resolveCitedChunks({ answer, chunks: attributionChunks });

  const filteredOutput = filterAnswerOutput({
    answer: attribution.answer,
    citations: attribution.citations,
    language: input.language,
    pii,
  });

  const citationVerification =
    env.RAG_CITATION_VERIFICATION_ENABLED && !filteredOutput.blocked
      ? await verifyCitations({
          answer: filteredOutput.answer,
          chunks: attributionChunks,
        })
      : null;

  return {
    answer: filteredOutput.answer,
    citations: filteredOutput.citations,
    insufficientEvidence: filteredOutput.blocked ? true : false,
    answerTruncated: generated.truncated,
    promptInjection: {
      suspiciousChunkCount: protectedChunks.suspiciousCount,
      blockedChunkCount: protectedChunks.blockedCount,
      suspiciousWebSourceCount: protectedWebSources.suspiciousCount,
      blockedWebSourceCount: protectedWebSources.blockedCount,
      blockedUserQuery: false,
    },
    outputFilter: {
      blocked: filteredOutput.blocked,
      filtered: filteredOutput.filtered,
      reasons: filteredOutput.reasons,
      redactionCount: filteredOutput.redactionCount,
    },
    citationAttribution: {
      markerCount: attribution.markerCount,
      invalidMarkerCount: attribution.invalidMarkerCount,
      fellBack: attribution.fellBack,
    },
    citationVerification,
    evidenceAssessment,
  };
}
