import type {
  Citation,
  RetrievedChunk,
  SupportedLanguage,
} from "@/lib/contracts/retrieval";
import { env } from "@/lib/config/env";
import {
  hasSufficientEvidence,
  selectChunkIndexesMeetingThreshold,
} from "@/lib/answering/policy";
import { resolveCitedChunks } from "@/lib/answering/citations";
import { orderEvidenceIndexes } from "@/lib/answering/evidence-order";
import {
  verifyCitedStatements,
  type CitationVerification,
} from "@/lib/answering/verification";
import { redactStreamedSentence } from "@/lib/security/output-filter";
import {
  buildGroundedAnswerUserPrompt,
  GROUNDED_ANSWER_SYSTEM_PROMPT,
  INSUFFICIENT_EVIDENCE_MESSAGE,
} from "@/lib/answering/prompts";
import {
  buildWebAugmentedUserPrompt,
  WEB_AUGMENTED_SYSTEM_PROMPT,
} from "@/lib/answering/web-augmented-prompts";
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
};

export type AnswerServiceDependencies = {
  llmProvider: LlmProvider;
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
    onSentence?: (sentence: string) => void;
  },
): Promise<string> {
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
    const redacted = redactStreamedSentence(sentence);
    if (redacted.halted) {
      halted = true;
      return;
    }
    if (redacted.text.trim()) {
      onSentence(redacted.text);
    }
  };

  const fullText = await llmProvider.generateAnswerStream(
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

  return fullText;
}

export async function generateGroundedAnswer(
  input: GenerateGroundedAnswerInput,
  overrides: Partial<AnswerServiceDependencies> = {},
): Promise<GenerateGroundedAnswerResult> {
  const llmProvider = overrides.llmProvider ?? getDefaultProviders().llm;
  const protectedChunks = protectRetrievedChunks(input.chunks);

  const citations = uniqueCitations(buildCitations(input.chunks));
  const sufficientEvidence = hasSufficientEvidence({
    chunks: protectedChunks.chunks,
    minEvidenceChunks: input.minEvidenceChunks,
    minRerankScore: input.minRerankScore,
    minHeuristicRelevance: input.minHeuristicRelevance,
    documentScoped: Boolean(input.documentScopeId),
  });

  if (!sufficientEvidence) {
    return {
      answer: INSUFFICIENT_EVIDENCE_MESSAGE,
      citations: citations.slice(0, 3),
      insufficientEvidence: true,
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
        reasons: [],
        redactionCount: 0,
      },
      citationAttribution: UNATTRIBUTED,
      citationVerification: null,
    };
  }

  // Evidence placement happens AFTER the gate (which reads score order) and
  // applies the same permutation to the sanitized prompt chunks and the raw
  // attribution chunks, so [n] markers keep resolving to the right chunk.
  const evidenceOrder = orderEvidenceIndexes(protectedChunks.chunks);
  const promptChunks = evidenceOrder.map(
    (index) => protectedChunks.chunks[index]!,
  );
  const attributionChunks = evidenceOrder.map((index) => input.chunks[index]!);

  const prompt = buildGroundedAnswerUserPrompt({
    query: input.query,
    language: input.language,
    chunks: promptChunks,
  });

  const answer = await generateAnswerText(llmProvider, {
    systemPrompt: GROUNDED_ANSWER_SYSTEM_PROMPT,
    userPrompt: prompt,
    language: input.language,
    maxOutputTokens: input.maxOutputTokens,
    onSentence: input.onSentence,
  });

  if (containsSensitiveLeakage(answer)) {
    return {
      answer: INSUFFICIENT_EVIDENCE_MESSAGE,
      citations: citations.slice(0, 3),
      insufficientEvidence: true,
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
    };
  }

  // Attribute before filtering: the marker indices refer to the model's own
  // output, and filterAnswerOutput may redact spans but never renumbers them.
  const attribution = resolveCitedChunks({ answer, chunks: attributionChunks });

  const filteredOutput = filterAnswerOutput({
    answer,
    citations: attribution.citations,
    language: input.language,
  });

  const citationVerification =
    env.RAG_CITATION_VERIFICATION_ENABLED && !filteredOutput.blocked
      ? await verifyCitedStatements({
          answer: filteredOutput.answer,
          chunks: attributionChunks,
        })
      : null;

  return {
    answer: filteredOutput.answer,
    citations: filteredOutput.citations,
    insufficientEvidence: filteredOutput.blocked ? true : false,
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
  const llmProvider = overrides.llmProvider ?? getDefaultProviders().llm;
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

  const minWebSources = Math.max(1, input.minWebSources ?? 2);
  if (
    !sufficientEvidence &&
    protectedWebSources.webSources.length < minWebSources
  ) {
    return {
      answer: INSUFFICIENT_EVIDENCE_MESSAGE,
      citations: citations.slice(0, 3),
      insufficientEvidence: true,
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

  const prompt = buildWebAugmentedUserPrompt({
    query: input.query,
    language: input.language,
    chunks: promptChunks,
    webSources: protectedWebSources.webSources,
  });

  const answer = await generateAnswerText(llmProvider, {
    systemPrompt: WEB_AUGMENTED_SYSTEM_PROMPT,
    userPrompt: prompt,
    language: input.language,
    maxOutputTokens: input.maxOutputTokens,
    onSentence: input.onSentence,
  });

  if (containsSensitiveLeakage(answer)) {
    return {
      answer: INSUFFICIENT_EVIDENCE_MESSAGE,
      citations: citations.slice(0, 3),
      insufficientEvidence: true,
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
    };
  }

  // Only the [n] document markers are resolved here. Web sources are marked
  // [WEB-n] by buildWebAugmentedUserPrompt and travel back to the client as
  // `webSources`, not as citations.
  const attribution = resolveCitedChunks({ answer, chunks: attributionChunks });

  const filteredOutput = filterAnswerOutput({
    answer,
    citations: attribution.citations,
    language: input.language,
  });

  const citationVerification =
    env.RAG_CITATION_VERIFICATION_ENABLED && !filteredOutput.blocked
      ? await verifyCitedStatements({
          answer: filteredOutput.answer,
          chunks: attributionChunks,
        })
      : null;

  return {
    answer: filteredOutput.answer,
    citations: filteredOutput.citations,
    insufficientEvidence: filteredOutput.blocked ? true : false,
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
  };
}
