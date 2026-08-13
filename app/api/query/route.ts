import { randomUUID } from "node:crypto";
import { z } from "zod";
import { after, NextResponse, type NextRequest } from "next/server";
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { flushTracing } from "@/lib/observability/langfuse";
import {
  generateGroundedAnswer,
  generateWebAugmentedAnswer,
} from "@/lib/answering/service";
import { INSUFFICIENT_EVIDENCE_MESSAGE } from "@/lib/answering/prompts";
import { requireAuthWithCsrf } from "@/lib/auth/request-auth";
import type { AuthUser } from "@/lib/auth/types";
import { env } from "@/lib/config/env";
import { listAccessibleDocumentIds } from "@/lib/ingestion/runtime/effective-documents";
import { logAuditEvent } from "@/lib/observability/audit";
import { emitQueryLatency, emitCacheHit } from "@/lib/observability/metrics";
import {
  markUserCohereApiKeyUsed,
  resolveUserCohereApiKey,
} from "@/lib/providers/cohere-vault";
import {
  markUserOpenAiApiKeyUsed,
  resolveUserOpenAiApiKey,
} from "@/lib/providers/openai-vault";
import { correctiveRetrieve } from "@/lib/retrieval/corrective";
import { detectQueryLanguage } from "@/lib/retrieval/language";
import { normalizeQuery } from "@/lib/retrieval/query";
import { retrieveRankedCandidatesWithRouting } from "@/lib/retrieval/router";
import { runWithRuntimeSecrets } from "@/lib/runtime/secrets";
import {
  buildPromptInjectionRefusal,
  shouldBlockUserPrompt,
} from "@/lib/security/prompt-injection";
import { consumeSharedRateLimit } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { performWebResearch } from "@/lib/web-research/service";
import type { WebSource } from "@/lib/web-research/types";

export const runtime = "nodejs";
export const maxDuration = 120;

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
  return sseEncoder.encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

function chunkAnswerText(answer: string): string[] {
  const tokens = answer.trim().split(/\s+/);
  if (tokens.length === 0) {
    return [];
  }
  return tokens.map((token, index) =>
    index === tokens.length - 1 ? token : `${token} `,
  );
}

function normalizeDocumentScopeInput(input: {
  documentId?: string;
  documentIds?: string[];
}): string[] {
  const scopeIds = new Set<string>();
  if (input.documentId) {
    scopeIds.add(input.documentId);
  }
  for (const documentId of input.documentIds ?? []) {
    scopeIds.add(documentId);
  }
  return [...scopeIds];
}

async function resolveAccessibleQueryScope(input: {
  user: AuthUser;
  requestedDocumentIds: string[];
}): Promise<{
  documentIds: string[] | undefined;
  unauthorizedDocumentIds: string[];
}> {
  if (input.user.role === "admin") {
    return {
      documentIds:
        input.requestedDocumentIds.length > 0
          ? input.requestedDocumentIds
          : undefined,
      unauthorizedDocumentIds: [],
    };
  }

  const accessibleDocumentIds = await listAccessibleDocumentIds(
    getSupabaseAdminClient(),
    {
      user: input.user,
    },
  );
  const accessibleSet = new Set(accessibleDocumentIds);

  if (input.requestedDocumentIds.length > 0) {
    const unauthorizedDocumentIds = input.requestedDocumentIds.filter(
      (documentId) => !accessibleSet.has(documentId),
    );
    return {
      documentIds:
        unauthorizedDocumentIds.length === 0
          ? input.requestedDocumentIds
          : undefined,
      unauthorizedDocumentIds,
    };
  }

  return {
    documentIds: accessibleDocumentIds,
    unauthorizedDocumentIds: [],
  };
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
      strategy: "standard" | "query_expansion";
      variationCount: number;
      hydeUsed: boolean;
      branchCount: number;
    };
    citationAttribution: {
      markerCount: number;
      invalidMarkerCount: number;
      fellBack: boolean;
    };
    citationVerification: {
      checkedCount: number;
      supportedCount: number;
      unsupportedCount: number;
      unverified: boolean;
    } | null;
    evidenceAssessment: {
      verdict: "sufficient" | "ambiguous" | "insufficient";
      top1Relevance: number | null;
      top3MeanRelevance: number | null;
      scale: "cross_encoder" | "heuristic" | "mixed" | "unknown";
      actionsTaken: string[];
      loopEnabled: boolean;
    } | null;
    answerTruncated: boolean;
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

  return sseResponse(stream);
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      // Security headers — Next.js global headers() config does not apply to
      // manually constructed Response objects returned from route handlers.
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
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
    { failOpen: false },
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

  const parsedRequestBody = querySchema.safeParse(
    await request.json().catch(() => null),
  );
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

    return NextResponse.json(
      { error: "Invalid query payload" },
      { status: 400 },
    );
  }
  const requestBody = parsedRequestBody.data;
  const requestedDocumentIds = normalizeDocumentScopeInput(requestBody);
  const { documentIds: scopedDocumentIds, unauthorizedDocumentIds } =
    await resolveAccessibleQueryScope({
      user: authResult.user,
      requestedDocumentIds,
    });
  const normalizedQuery = normalizeQuery(requestBody.query);
  const requestLanguage = detectQueryLanguage(
    normalizedQuery,
    requestBody.languageHint,
  );
  const queryId = randomUUID();
  const conversationId = requestBody.conversationId ?? queryId;

  if (unauthorizedDocumentIds.length > 0) {
    logAuditEvent({
      action: "query.execute",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: "query",
      ipAddress,
      metadata: {
        reason: "document_scope_forbidden",
        documentIds: requestedDocumentIds,
        unauthorizedDocumentIds,
      },
    });

    return NextResponse.json(
      { error: "One or more scoped documents are not accessible." },
      { status: 403 },
    );
  }

  if (
    authResult.user.role !== "admin" &&
    (!scopedDocumentIds || scopedDocumentIds.length === 0)
  ) {
    const retrievalMeta = {
      cacheHit: false,
      latencyMs: 0,
      selectedChunkIds: [],
      selectedDocumentIds: [],
      insufficientEvidence: true,
      conversationId,
      documentScopeId: null,
      documentScopeIds: [],
      rateLimit: {
        remaining: rate.remaining,
        retryAfterSeconds: rate.retryAfterSeconds,
      },
      promptInjection: {
        blockedUserQuery: false,
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
      citationAttribution: {
        markerCount: 0,
        invalidMarkerCount: 0,
        fellBack: false,
      },
      citationVerification: null,
      evidenceAssessment: null,
      answerTruncated: false,
    };

    return buildQueryStreamResponse({
      queryId,
      answer: INSUFFICIENT_EVIDENCE_MESSAGE,
      citations: [],
      retrievalMeta,
    });
  }

  if (shouldBlockUserPrompt(requestBody.query)) {
    const answer = buildPromptInjectionRefusal(requestLanguage);
    const retrievalMeta = {
      cacheHit: false,
      latencyMs: 0,
      selectedChunkIds: [],
      selectedDocumentIds: scopedDocumentIds ?? [],
      insufficientEvidence: true,
      conversationId,
      documentScopeId:
        scopedDocumentIds?.length === 1 ? scopedDocumentIds[0]! : null,
      documentScopeIds: scopedDocumentIds ?? [],
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
      citationAttribution: {
        markerCount: 0,
        invalidMarkerCount: 0,
        fellBack: false,
      },
      citationVerification: null,
      evidenceAssessment: null,
      answerTruncated: false,
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
        documentId:
          scopedDocumentIds?.length === 1 ? scopedDocumentIds[0]! : null,
        documentIds: scopedDocumentIds ?? [],
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
    // The Cohere key is only consumed by the cross-encoder; skip decrypting a
    // user's stored key entirely when that stage is disabled.
    [userOpenAiApiKey, userCohereApiKey] = await Promise.all([
      resolveUserOpenAiApiKey(authResult.user.id),
      env.RAG_CROSS_ENCODER_ENABLED
        ? resolveUserCohereApiKey(authResult.user.id)
        : Promise.resolve(null),
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
    return NextResponse.json(
      { error: "Failed to resolve user provider credentials" },
      { status: 500 },
    );
  }

  // Narrowing on authResult.ok does not flow into the closures below, and the
  // streamed work outlives this scope; capture the narrowed user once.
  const authUser = authResult.user;

  // Serverless runtimes freeze the sandbox as soon as the response completes,
  // discarding anything still buffered. after() runs once the stream has
  // closed, which is the last moment spans can still be shipped.
  after(flushTracing);

  return runWithRuntimeSecrets(
    {
      openAiApiKey: userOpenAiApiKey ?? undefined,
      cohereApiKey: userCohereApiKey ?? undefined,
    },
    async () =>
      // Applied to the root and inherited by every child observation, so a
      // trace can be found by user or replayed as a conversation.
      propagateAttributes(
        {
          // Without traceName the trace lands in the Langfuse trace table
          // with a blank name, which makes it unfilterable.
          traceName: "rag-query",
          userId: authUser.id,
          sessionId: conversationId,
          tags: [
            "query",
            requestBody.enableWebResearch ? "web-research" : "documents-only",
          ],
          metadata: { role: authUser.role, route: "/api/query" },
        },
        async () =>
          startActiveObservation(
            "rag-query",
            async (rootObservation) => {
              rootObservation.update({
                input: requestBody.query,
                metadata: {
                  topK: requestBody.topK ?? env.RAG_DEFAULT_TOP_K,
                  languageHint: requestBody.languageHint ?? null,
                  documentScopeIds: scopedDocumentIds ?? [],
                  enableQueryExpansion: Boolean(
                    requestBody.enableQueryExpansion,
                  ),
                  queryId,
                },
              });

              const startedAt = Date.now();
              const topK = requestBody.topK ?? env.RAG_DEFAULT_TOP_K;

              try {
                const retrievalDocumentIds =
                  scopedDocumentIds && scopedDocumentIds.length > 0
                    ? scopedDocumentIds
                    : undefined;
                const retrievalCacheNamespace = `user:${authResult.user.id}::docs:${retrievalDocumentIds ? retrievalDocumentIds.join(",") : "all"}`;
                const retrievalResult =
                  await retrieveRankedCandidatesWithRouting({
                    query: requestBody.query,
                    topK,
                    languageHint: requestBody.languageHint,
                    documentIds: retrievalDocumentIds,
                    cacheNamespace: retrievalCacheNamespace,
                    enableQueryExpansion: requestBody.enableQueryExpansion,
                  });

                let webSources: WebSource[] = [];
                if (
                  requestBody.enableWebResearch &&
                  env.RAG_WEB_SEARCH_ENABLED
                ) {
                  try {
                    webSources = await performWebResearch(requestBody.query);
                  } catch {
                    // Continue without web sources if search fails.
                  }
                }

                // The relaxed single-chunk evidence requirement is reserved for scopes
                // the user explicitly selected. A reader's injected RBAC list (every
                // document they can access) is not a deliberate scoping decision and
                // must not weaken the gate.
                const explicitScopeId =
                  requestedDocumentIds.length > 0 &&
                  scopedDocumentIds &&
                  scopedDocumentIds.length > 0
                    ? scopedDocumentIds.join(",")
                    : null;

                type AnswerResult = Awaited<
                  ReturnType<typeof generateGroundedAnswer>
                >;

                // Meta with answer-dependent fields at their defaults; the `final`
                // event carries the authoritative values.
                const buildRetrievalOnlyMeta = () => ({
                  cacheHit: retrievalResult.trace.cacheHit,
                  latencyMs: Date.now() - startedAt,
                  selectedChunkIds: retrievalResult.chunks.map(
                    (chunk) => chunk.chunkId,
                  ),
                  selectedDocumentIds: [
                    ...new Set(
                      retrievalResult.chunks.map((chunk) => chunk.documentId),
                    ),
                  ],
                  retrievalTrace: retrievalResult.trace,
                  insufficientEvidence: false,
                  conversationId,
                  documentScopeId:
                    scopedDocumentIds?.length === 1
                      ? scopedDocumentIds[0]!
                      : null,
                  documentScopeIds: scopedDocumentIds ?? [],
                  rateLimit: {
                    remaining: rate.remaining,
                    retryAfterSeconds: rate.retryAfterSeconds,
                  },
                  promptInjection: {
                    blockedUserQuery: false,
                    suspiciousChunkCount: 0,
                    blockedChunkCount: 0,
                    suspiciousWebSourceCount: 0,
                    blockedWebSourceCount: 0,
                  },
                  outputFilter: {
                    blocked: false,
                    filtered: false,
                    reasons: [] as string[],
                    redactionCount: 0,
                  },
                  queryExpansion: retrievalResult.queryExpansion,
                  citationAttribution: {
                    markerCount: 0,
                    invalidMarkerCount: 0,
                    fellBack: false,
                  },
                  citationVerification: null as
                    AnswerResult["citationVerification"] | null,
                  evidenceAssessment:
                    null as AnswerResult["evidenceAssessment"],
                  answerTruncated: false,
                });

                const buildFullMeta = (
                  answerResult: AnswerResult,
                  latencyMs: number,
                ) => ({
                  ...buildRetrievalOnlyMeta(),
                  latencyMs,
                  insufficientEvidence: answerResult.insufficientEvidence,
                  promptInjection: answerResult.promptInjection,
                  outputFilter: answerResult.outputFilter,
                  citationAttribution: answerResult.citationAttribution,
                  citationVerification: answerResult.citationVerification,
                  evidenceAssessment: answerResult.evidenceAssessment,
                  answerTruncated: answerResult.answerTruncated,
                });

                const persistQueryHistory = async (
                  answerResult: AnswerResult,
                  latencyMs: number,
                ): Promise<string | undefined> => {
                  const supabase = getSupabaseAdminClient();
                  try {
                    const { data: historyRow, error: historyError } =
                      await supabase
                        .from("query_history")
                        .insert({
                          user_id: authUser.id,
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
                        actorId: authUser.id,
                        actorRole: authUser.role,
                        outcome: "failure",
                        resource: "query_history",
                        ipAddress,
                        metadata: {
                          reason: "query_history_insert_failed",
                          message: historyError.message,
                        },
                      });
                      return undefined;
                    }
                    return historyRow?.id;
                  } catch {
                    // Continue response path if history write fails entirely.
                    return undefined;
                  }
                };

                const touchByokKeys = (): void => {
                  if (userOpenAiApiKey) {
                    void markUserOpenAiApiKeyUsed(authUser.id).catch(
                      (touchError) => {
                        logAuditEvent({
                          action: "openai.byok.touch",
                          actorId: authUser.id,
                          actorRole: authUser.role,
                          outcome: "failure",
                          resource: "openai_byok_vault",
                          ipAddress,
                          metadata: {
                            reason: "touch_failed",
                            message:
                              touchError instanceof Error
                                ? touchError.message
                                : "unknown_error",
                          },
                        });
                      },
                    );
                  }

                  if (userCohereApiKey && env.RAG_CROSS_ENCODER_ENABLED) {
                    void markUserCohereApiKeyUsed(authUser.id).catch(
                      (touchError) => {
                        logAuditEvent({
                          action: "cohere.byok.touch",
                          actorId: authUser.id,
                          actorRole: authUser.role,
                          outcome: "failure",
                          resource: "cohere_byok_vault",
                          ipAddress,
                          metadata: {
                            reason: "touch_failed",
                            message:
                              touchError instanceof Error
                                ? touchError.message
                                : "unknown_error",
                          },
                        });
                      },
                    );
                  }
                };

                const logSuccessAudit = (answerResult: AnswerResult): void => {
                  logAuditEvent({
                    action: "query.execute",
                    actorId: authUser.id,
                    actorRole: authUser.role,
                    outcome: "success",
                    resource: "query",
                    ipAddress,
                    metadata: {
                      conversationId: requestBody.conversationId ?? null,
                      languageHint: requestBody.languageHint ?? null,
                      topK,
                      documentId:
                        scopedDocumentIds?.length === 1
                          ? scopedDocumentIds[0]!
                          : null,
                      documentIds: scopedDocumentIds ?? [],
                      selectedChunkCount: retrievalResult.chunks.length,
                      selectedDocumentIds: [
                        ...new Set(
                          retrievalResult.chunks.map(
                            (chunk) => chunk.documentId,
                          ),
                        ),
                      ],
                      cacheHit: retrievalResult.trace.cacheHit,
                      retrievalVersion: retrievalResult.trace.retrievalVersion,
                      retrievalConfigFingerprint:
                        retrievalResult.trace.configFingerprint,
                      insufficientEvidence: answerResult.insufficientEvidence,
                      promptInjection: answerResult.promptInjection,
                      outputFilter: answerResult.outputFilter,
                      queryExpansion: retrievalResult.queryExpansion,
                      citationAttribution: answerResult.citationAttribution,
                      citationVerification: answerResult.citationVerification,
                      evidenceAssessment: answerResult.evidenceAssessment,
                      citationCount: answerResult.citations.length,
                      resolvedConversationId: conversationId,
                      openAiKeySource: userOpenAiApiKey
                        ? "byok_vault"
                        : "server_env",
                      cohereKeySource: userCohereApiKey
                        ? "byok_vault"
                        : "server_env",
                    },
                  });
                };

                // True streaming: answer generation runs inside the SSE stream so
                // per-sentence-redacted sentences reach the client as they are
                // generated. The `final` event stays authoritative — its answer has
                // passed the full output filter and the client replaces streamed
                // text with it (which is also how a rare late retraction works).
                // NOTE: start() is invoked synchronously at construction, inside
                // runWithRuntimeSecrets, so BYOK runtime secrets propagate into the
                // streamed LLM call via AsyncLocalStorage.
                const stream = new ReadableStream<Uint8Array>({
                  start: async (controller) => {
                    let clientGone = false;
                    const emit = (event: string, data: unknown) => {
                      if (clientGone) {
                        return;
                      }
                      try {
                        controller.enqueue(encodeSseEvent(event, data));
                      } catch {
                        // Client disconnected mid-stream; keep finishing side
                        // effects (history, audit) without emitting.
                        clientGone = true;
                      }
                    };

                    try {
                      emit("meta", {
                        queryId,
                        retrievalMeta: buildRetrievalOnlyMeta(),
                      });

                      const answerResult =
                        webSources.length > 0
                          ? await generateWebAugmentedAnswer({
                              query: requestBody.query,
                              language: retrievalResult.trace.language,
                              chunks: retrievalResult.chunks,
                              minEvidenceChunks: env.RAG_MIN_EVIDENCE_CHUNKS,
                              minRerankScore: env.RAG_MIN_RERANK_SCORE,
                              minHeuristicRelevance:
                                env.RAG_MIN_HEURISTIC_RELEVANCE,
                              maxOutputTokens: env.RAG_LLM_MAX_OUTPUT_TOKENS,
                              documentScopeId: explicitScopeId,
                              webSources,
                              minWebSources: env.RAG_WEB_MIN_SOURCES,
                              onSentence: (sentence) =>
                                emit("token", { queryId, token: sentence }),
                            })
                          : await generateGroundedAnswer(
                              {
                                query: requestBody.query,
                                language: retrievalResult.trace.language,
                                chunks: retrievalResult.chunks,
                                minEvidenceChunks: env.RAG_MIN_EVIDENCE_CHUNKS,
                                minRerankScore: env.RAG_MIN_RERANK_SCORE,
                                minHeuristicRelevance:
                                  env.RAG_MIN_HEURISTIC_RELEVANCE,
                                maxOutputTokens: env.RAG_LLM_MAX_OUTPUT_TOKENS,
                                documentScopeId: explicitScopeId,
                                onSentence: (sentence) =>
                                  emit("token", { queryId, token: sentence }),
                              },
                              // The corrective pass is wired only when its flag is
                              // on, so the disabled configuration cannot even reach
                              // the second retrieval path. It must reuse the same
                              // document scope/cache namespace as the primary
                              // retrieval pass above — otherwise it searches the
                              // entire corpus regardless of the caller's access.
                              env.RAG_CRAG_CORRECTIVE_RETRIEVAL_ENABLED
                                ? {
                                    correctiveRetrieve: (query, language) =>
                                      correctiveRetrieve(query, language, {
                                        documentIds: retrievalDocumentIds,
                                        cacheNamespace:
                                          retrievalCacheNamespace,
                                      }),
                                  }
                                : {},
                            );
                      const latencyMs = Date.now() - startedAt;

                      emitQueryLatency(latencyMs, { userId: authUser.id });
                      emitCacheHit(retrievalResult.trace.cacheHit, {
                        userId: authUser.id,
                      });

                      const retrievalMeta = buildFullMeta(
                        answerResult,
                        latencyMs,
                      );
                      const queryHistoryId = await persistQueryHistory(
                        answerResult,
                        latencyMs,
                      );
                      touchByokKeys();
                      logSuccessAudit(answerResult);

                      // The authoritative answer — the one that passed the
                      // full output filter — is what the trace reports, not
                      // the streamed text, which a late retraction can undo.
                      rootObservation.update({
                        output: answerResult.answer,
                        metadata: {
                          latencyMs,
                          cacheHit: retrievalResult.trace.cacheHit,
                          insufficientEvidence:
                            answerResult.insufficientEvidence,
                          citationCount: answerResult.citations.length,
                          queryHistoryId: queryHistoryId ?? null,
                        },
                      });

                      emit("final", {
                        queryId,
                        answer: answerResult.answer,
                        citations: answerResult.citations,
                        retrievalMeta,
                        webSources: webSources.length ? webSources : undefined,
                        queryHistoryId,
                      });
                      emit("done", { queryId });
                    } catch (error) {
                      const message =
                        error instanceof Error
                          ? error.message
                          : "unknown_error";
                      logAuditEvent({
                        action: "query.execute",
                        actorId: authUser.id,
                        actorRole: authUser.role,
                        outcome: "failure",
                        resource: "query",
                        ipAddress,
                        metadata: {
                          reason: "answer_generation_failed",
                          message,
                        },
                      });
                      emit("final", {
                        queryId,
                        answer:
                          "The answer could not be generated. Please retry.",
                        citations: [],
                        retrievalMeta: buildRetrievalOnlyMeta(),
                        error: "answer_generation_failed",
                      });
                      emit("done", { queryId });

                      rootObservation.update({
                        output: { error: "answer_generation_failed", message },
                        level: "ERROR",
                        statusMessage: message,
                      });
                    } finally {
                      // endOnExit is disabled on the root observation, so this
                      // is the only place the streamed path closes it. Missing
                      // it would leave every trace permanently unfinished.
                      rootObservation.end();
                      try {
                        controller.close();
                      } catch {
                        // Already closed or cancelled.
                      }
                    }
                  },
                });

                return sseResponse(stream);
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : "unknown_error";
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

                // Retrieval threw before the stream existed, so nothing downstream
                // will close the root observation.
                rootObservation.update({
                  output: { error: "retrieval_failed", message },
                  level: "ERROR",
                  statusMessage: message,
                });
                rootObservation.end();

                return NextResponse.json(
                  { error: "Failed to retrieve ranked chunks" },
                  { status: 500 },
                );
              }
            },
            // The answer is generated inside the SSE stream, long after this
            // callback returns the Response. Ending on exit would cut the root
            // span short, before the answer it is supposed to report exists.
            { asType: "span", endOnExit: false },
          ),
      ),
  );
}
