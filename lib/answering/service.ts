import type {
  Citation,
  RetrievedChunk,
  SupportedLanguage,
} from "@/lib/contracts/retrieval";
import {
  hasSufficientEvidence,
  selectChunkIndexesMeetingThreshold,
} from "@/lib/answering/policy";
import { resolveCitedChunks } from "@/lib/answering/citations";
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
    };
  }

  const prompt = buildGroundedAnswerUserPrompt({
    query: input.query,
    language: input.language,
    chunks: protectedChunks.chunks,
  });

  const answer = await llmProvider.generateAnswer({
    systemPrompt: GROUNDED_ANSWER_SYSTEM_PROMPT,
    userPrompt: prompt,
    language: input.language,
    maxOutputTokens: input.maxOutputTokens,
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
    };
  }

  // Attribute before filtering: the marker indices refer to the model's own
  // output, and filterAnswerOutput may redact spans but never renumbers them.
  const attribution = resolveCitedChunks({ answer, chunks: input.chunks });

  const filteredOutput = filterAnswerOutput({
    answer,
    citations: attribution.citations,
    language: input.language,
  });

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

  const prompt = buildWebAugmentedUserPrompt({
    query: input.query,
    language: input.language,
    chunks: promptChunks,
    webSources: protectedWebSources.webSources,
  });

  const answer = await llmProvider.generateAnswer({
    systemPrompt: WEB_AUGMENTED_SYSTEM_PROMPT,
    userPrompt: prompt,
    language: input.language,
    maxOutputTokens: input.maxOutputTokens,
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
  };
}
