import type { Citation, RetrievedChunk, SupportedLanguage } from "@/lib/contracts/retrieval";
import { hasSufficientEvidence } from "@/lib/answering/policy";
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
};

export type AnswerServiceDependencies = {
  llmProvider: LlmProvider;
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
    };
  }

  return {
    answer,
    citations,
    insufficientEvidence: false,
    promptInjection: {
      suspiciousChunkCount: protectedChunks.suspiciousCount,
      blockedChunkCount: protectedChunks.blockedCount,
      suspiciousWebSourceCount: 0,
      blockedWebSourceCount: 0,
      blockedUserQuery: false,
    },
  };
}

export type GenerateWebAugmentedAnswerInput = GenerateGroundedAnswerInput & {
  webSources: WebSource[];
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
    documentScoped: Boolean(input.documentScopeId),
  });

  if (!sufficientEvidence && protectedWebSources.webSources.length === 0) {
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
    };
  }

  const prompt = buildWebAugmentedUserPrompt({
    query: input.query,
    language: input.language,
    chunks: protectedChunks.chunks,
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
    };
  }

  return {
    answer,
    citations,
    insufficientEvidence: false,
    promptInjection: {
      suspiciousChunkCount: protectedChunks.suspiciousCount,
      blockedChunkCount: protectedChunks.blockedCount,
      suspiciousWebSourceCount: protectedWebSources.suspiciousCount,
      blockedWebSourceCount: protectedWebSources.blockedCount,
      blockedUserQuery: false,
    },
  };
}
