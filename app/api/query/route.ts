import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { generateGroundedAnswer, generateWebAugmentedAnswer } from "@/lib/answering/service";
import { requireAuthWithCsrf } from "@/lib/auth/request-auth";
import { env } from "@/lib/config/env";
import { logAuditEvent } from "@/lib/observability/audit";
import { emitQueryLatency, emitCacheHit } from "@/lib/observability/metrics";
import { markUserCohereApiKeyUsed, resolveUserCohereApiKey } from "@/lib/providers/cohere-vault";
import { markUserOpenAiApiKeyUsed, resolveUserOpenAiApiKey } from "@/lib/providers/openai-vault";
import { detectQueryLanguage } from "@/lib/retrieval/language";
import { normalizeQuery } from "@/lib/retrieval/query";
import { retrieveRankedCandidatesWithRouting } from "@/lib/retrieval/router";
import { runWithRuntimeSecrets } from "@/lib/runtime/secrets";
import { buildPromptInjectionRefusal, shouldBlockUserPrompt } from "@/lib/security/prompt-injection";
import { consumeSharedRateLimit } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { performWebResearch } from "@/lib/web-research/service";
import type { WebSource } from "@/lib/web-research/types";

export const runtime = "nodejs";

const querySchema = z.object({
  query: z.string().min(1).max(2000),
  conversationId: z.string().uuid().optional(),
  documentId: z.string().uuid().optional(),
  documentIds: z.array(z.string().uuid()).max(50).optional(),
  enableQueryExpansion: z.boolean().optional(),
  languageHint: z.enum(["EN", "DE", "FR", "IT", "ES"]).optional(),
  topK: z.number().int().positive().max(20).optional(),
  enableWebResearch: z.boolean().optional(),
});

const sseEncoder = new TextEncoder();

function encodeSseEvent(event: string, data: unknown): Uint8Array {
  return sseEncoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function chunkAnswerText(answer: string): string[] {
  const tokens = answer.trim().split(/\s+/);
  if (tokens.length === 0) {
    return [];
  }
  return tokens.map((token, index) => (index === tokens.length - 1 ? token : `${token} `));
}

function normalizeDocumentScopeInput(input: { documentId?: string; documentIds?: string[] }): string[] {
  const scopeIds = new Set<string>();
  if (input.documentId) {
    scopeIds.add(input.documentId);
  }
  for (const documentId of input.documentIds ?? []) {
    scopeIds.add(documentId);
  }
  return [...scopeIds];
}

function buildQueryStreamResponse(input: {
  queryId: string;
  answer: string;
  citations: Array<{
    documentId: string;
    pageNumber: number;
    chunkId: string;
  }>;
  retrievalMeta: {
    cacheHit: boolean;
    latencyMs: number;
    selectedChunkIds: string[];
    selectedDocumentIds: string[];
    retrievalTrace?: unknown;
    insufficientEvidence: boolean;
    conversationId: string;
    documentScopeId: string | null;
    documentScopeIds: string[];
    rateLimit: {
      remaining: number;
      retryAfterSeconds: number;
    };
    promptInjection: {
      blockedUserQuery: boolean;
      suspiciousChunkCount: number;
      blockedChunkCount: number;
      suspiciousWebSourceCount: number;
      blockedWebSourceCount: number;
    };
    outputFilter: {
      blocked: boolean;
      filtered: boolean;
      reasons: string[];
      redactionCount: number;
    };
    queryExpansion: {
      requested: boolean;
      applied: boolean;
      strategy: "standard" | "multi_document_expansion";
      variationCount: number;
      hydeUsed: boolean;
      branchCount: number;
    };
  };
  webSources?: WebSource[];
  queryHistoryId?: string;
}): Response {
  const answerTokens = chunkAnswerText(input.answer);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encodeSseEvent("meta", {
          queryId: input.queryId,
          retrievalMeta: input.retrievalMeta,
        }),
      );

      for (const token of answerTokens) {
        controller.enqueue(
          encodeSseEvent("token", {
            queryId: input.queryId,
            token,
          }),
        );
      }

      controller.enqueue(
        encodeSseEvent("final", {
          queryId: input.queryId,
          answer: input.answer,
          citations: input.citations,
          retrievalMeta: input.retrievalMeta,
          webSources: input.webSources?.length ? input.webSources : undefined,
          queryHistoryId: input.queryHistoryId,
        }),
      );
      controller.enqueue(encodeSseEvent("done", { queryId: input.queryId }));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(request: NextRequest) {
  const authResult = await requireAuthWithCsrf(request, ["reader", "admin"]);
  const ipAddress = getClientIp(request);

  if (!authResult.ok) {
    logAuditEvent({
      action: "query.execute",
      actorId: null,
      actorRole: "anonymous",
      outcome: "failure",
      resource: "query",
      ipAddress,
      metadata: { reason: "unauthorized" },
    });

    return authResult.response;
  }

  const rate = await consumeSharedRateLimit(
    `${authResult.user.id}:${ipAddress}`,
    env.AUTH_RATE_LIMIT_MAX_REQUESTS,
    env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
  );

  if (!rate.allowed) {
    logAuditEvent({
      action: "query.execute",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: "query",
      ipAddress,
      metadata: {
        reason: "rate_limited",
        retryAfterSeconds: rate.retryAfterSeconds,
      },
    });

    return NextResponse.json(
      {
        error: "Rate limit exceeded",
        retryAfterSeconds: rate.retryAfterSeconds,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rate.retryAfterSeconds),
        },
      },
    );
  }

  const parsedRequestBody = querySchema.safeParse(await request.json().catch(() => null));
  if (!parsedRequestBody.success) {
    logAuditEvent({
      action: "query.execute",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: "query",
      ipAddress,
      metadata: { reason: "invalid_request_body" },
    });

    return NextResponse.json({ error: "Invalid query payload" }, { status: 400 });
  }
  const requestBody = parsedRequestBody.data;
  const scopedDocumentIds = normalizeDocumentScopeInput(requestBody);
  const normalizedQuery = normalizeQuery(requestBody.query);
  const requestLanguage = detectQueryLanguage(normalizedQuery, requestBody.languageHint);
  const queryId = randomUUID();
  const conversationId = requestBody.conversationId ?? queryId;

  if (shouldBlockUserPrompt(requestBody.query)) {
    const answer = buildPromptInjectionRefusal(requestLanguage);
    const retrievalMeta = {
      cacheHit: false,
      latencyMs: 0,
      selectedChunkIds: [],
      selectedDocumentIds: scopedDocumentIds,
      insufficientEvidence: true,
      conversationId,
      documentScopeId: scopedDocumentIds.length === 1 ? scopedDocumentIds[0]! : null,
      documentScopeIds: scopedDocumentIds,
      rateLimit: {
        remaining: rate.remaining,
        retryAfterSeconds: rate.retryAfterSeconds,
      },
      promptInjection: {
        blockedUserQuery: true,
        suspiciousChunkCount: 0,
        blockedChunkCount: 0,
        suspiciousWebSourceCount: 0,
        blockedWebSourceCount: 0,
      },
      outputFilter: {
        blocked: false,
        filtered: false,
        reasons: [],
        redactionCount: 0,
      },
      queryExpansion: {
        requested: Boolean(requestBody.enableQueryExpansion),
        applied: false,
        strategy: "standard" as const,
        variationCount: 0,
        hydeUsed: false,
        branchCount: 1,
      },
    };

    logAuditEvent({
      action: "query.execute",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: "query",
      ipAddress,
      metadata: {
        reason: "prompt_injection_blocked",
        documentId: scopedDocumentIds.length === 1 ? scopedDocumentIds[0]! : null,
        documentIds: scopedDocumentIds,
      },
    });

    return buildQueryStreamResponse({
      queryId,
      answer,
      citations: [],
      retrievalMeta,
    });
  }

  let userOpenAiApiKey: string | null = null;
  let userCohereApiKey: string | null = null;
  try {
    [userOpenAiApiKey, userCohereApiKey] = await Promise.all([
      resolveUserOpenAiApiKey(authResult.user.id),
      resolveUserCohereApiKey(authResult.user.id),
    ]);
  } catch (error) {
    logAuditEvent({
      action: "query.execute",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: "query",
      ipAddress,
      metadata: {
        reason: "provider_byok_resolve_failed",
        message: error instanceof Error ? error.message : "unknown_error",
      },
    });
    return NextResponse.json({ error: "Failed to resolve user provider credentials" }, { status: 500 });
  }

  return runWithRuntimeSecrets(
    {
      openAiApiKey: userOpenAiApiKey ?? undefined,
      cohereApiKey: userCohereApiKey ?? undefined,
    },
    async () => {
      const startedAt = Date.now();
      const topK = requestBody.topK ?? env.RAG_DEFAULT_TOP_K;

      try {
        const retrievalResult = await retrieveRankedCandidatesWithRouting({
          query: requestBody.query,
          topK,
          languageHint: requestBody.languageHint,
          documentIds: scopedDocumentIds.length > 0 ? scopedDocumentIds : undefined,
          cacheNamespace: `user:${authResult.user.id}::docs:${scopedDocumentIds.length > 0 ? scopedDocumentIds.join(",") : "all"}`,
          enableQueryExpansion: requestBody.enableQueryExpansion,
        });


        let webSources: WebSource[] = [];
        if (requestBody.enableWebResearch && env.RAG_WEB_SEARCH_ENABLED) {
          try {
            webSources = await performWebResearch(requestBody.query);
          } catch {
            // Continue without web sources if search fails.
          }
        }

        const answerResult = webSources.length > 0
          ? await generateWebAugmentedAnswer({
              query: requestBody.query,
              language: retrievalResult.trace.language,
              chunks: retrievalResult.chunks,
              minEvidenceChunks: env.RAG_MIN_EVIDENCE_CHUNKS,
              minRerankScore: env.RAG_MIN_RERANK_SCORE,
              maxOutputTokens: env.RAG_LLM_MAX_OUTPUT_TOKENS,
              documentScopeId: scopedDocumentIds.length > 0 ? scopedDocumentIds.join(",") : null,
              webSources,
            })
          : await generateGroundedAnswer({
              query: requestBody.query,
              language: retrievalResult.trace.language,
              chunks: retrievalResult.chunks,
              minEvidenceChunks: env.RAG_MIN_EVIDENCE_CHUNKS,
              minRerankScore: env.RAG_MIN_RERANK_SCORE,
              maxOutputTokens: env.RAG_LLM_MAX_OUTPUT_TOKENS,
              documentScopeId: scopedDocumentIds.length > 0 ? scopedDocumentIds.join(",") : null,
            });
        const latencyMs = Date.now() - startedAt;

        emitQueryLatency(latencyMs, { userId: authResult.user.id });
        emitCacheHit(retrievalResult.trace.cacheHit, { userId: authResult.user.id });

        const retrievalMeta = {
          cacheHit: retrievalResult.trace.cacheHit,
          latencyMs,
          selectedChunkIds: retrievalResult.chunks.map((chunk) => chunk.chunkId),
          selectedDocumentIds: [...new Set(retrievalResult.chunks.map((chunk) => chunk.documentId))],
          retrievalTrace: retrievalResult.trace,
          insufficientEvidence: answerResult.insufficientEvidence,
          conversationId,
          documentScopeId: scopedDocumentIds.length === 1 ? scopedDocumentIds[0]! : null,
          documentScopeIds: scopedDocumentIds,
          rateLimit: {
            remaining: rate.remaining,
            retryAfterSeconds: rate.retryAfterSeconds,
          },
          promptInjection: answerResult.promptInjection,
          outputFilter: answerResult.outputFilter,
          queryExpansion: retrievalResult.queryExpansion,
        };

        const supabase = getSupabaseAdminClient();
        let queryHistoryId: string | undefined;
        try {
          const { data: historyRow, error: historyError } = await supabase
            .from("query_history")
            .insert({
              user_id: authResult.user.id,
              conversation_id: conversationId,
              query: requestBody.query,
              answer: answerResult.answer,
              citations: answerResult.citations,
              latency_ms: latencyMs,
              cache_hit: retrievalResult.trace.cacheHit,
            })
            .select("id")
            .single();

          if (historyError) {
            logAuditEvent({
              action: "query.history.write",
              actorId: authResult.user.id,
              actorRole: authResult.user.role,
              outcome: "failure",
              resource: "query_history",
              ipAddress,
              metadata: { reason: "query_history_insert_failed", message: historyError.message },
            });
          } else {
            queryHistoryId = historyRow?.id;
          }
        } catch {
          // Continue response path if history write fails entirely.
        }

        if (userOpenAiApiKey) {
          void markUserOpenAiApiKeyUsed(authResult.user.id).catch((touchError) => {
            logAuditEvent({
              action: "openai.byok.touch",
              actorId: authResult.user.id,
              actorRole: authResult.user.role,
              outcome: "failure",
              resource: "openai_byok_vault",
              ipAddress,
              metadata: {
                reason: "touch_failed",
                message: touchError instanceof Error ? touchError.message : "unknown_error",
              },
            });
          });
        }

        if (userCohereApiKey && env.RAG_CROSS_ENCODER_ENABLED) {
          void markUserCohereApiKeyUsed(authResult.user.id).catch((touchError) => {
            logAuditEvent({
              action: "cohere.byok.touch",
              actorId: authResult.user.id,
              actorRole: authResult.user.role,
              outcome: "failure",
              resource: "cohere_byok_vault",
              ipAddress,
              metadata: {
                reason: "touch_failed",
                message: touchError instanceof Error ? touchError.message : "unknown_error",
              },
            });
          });
        }

        logAuditEvent({
          action: "query.execute",
          actorId: authResult.user.id,
          actorRole: authResult.user.role,
          outcome: "success",
          resource: "query",
          ipAddress,
          metadata: {
            conversationId: requestBody.conversationId ?? null,
            languageHint: requestBody.languageHint ?? null,
            topK,
            documentId: scopedDocumentIds.length === 1 ? scopedDocumentIds[0]! : null,
            documentIds: scopedDocumentIds,
            selectedChunkCount: retrievalResult.chunks.length,
            selectedDocumentIds: [...new Set(retrievalResult.chunks.map((chunk) => chunk.documentId))],
            cacheHit: retrievalResult.trace.cacheHit,
            retrievalVersion: retrievalResult.trace.retrievalVersion,
            insufficientEvidence: answerResult.insufficientEvidence,
            promptInjection: answerResult.promptInjection,
            outputFilter: answerResult.outputFilter,
            queryExpansion: retrievalResult.queryExpansion,
            resolvedConversationId: conversationId,
            openAiKeySource: userOpenAiApiKey ? "byok_vault" : "server_env",
            cohereKeySource: userCohereApiKey ? "byok_vault" : "server_env",
          },
        });

        return buildQueryStreamResponse({
          queryId,
          answer: answerResult.answer,
          citations: answerResult.citations,
          retrievalMeta,
          webSources,
          queryHistoryId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown_error";
        logAuditEvent({
          action: "query.execute",
          actorId: authResult.user.id,
          actorRole: authResult.user.role,
          outcome: "failure",
          resource: "query",
          ipAddress,
          metadata: {
            reason: "retrieval_failed",
            message,
          },
        });

        return NextResponse.json({ error: "Failed to retrieve ranked chunks" }, { status: 500 });
      }
    },
  );
}
