import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { generateGroundedAnswer } from "@/lib/answering/service";
import { requireAuth } from "@/lib/auth/request-auth";
import { env } from "@/lib/config/env";
import { logAuditEvent } from "@/lib/observability/audit";
import { markUserOpenAiApiKeyUsed, resolveUserOpenAiApiKey } from "@/lib/providers/openai-vault";
import { retrieveRankedCandidates } from "@/lib/retrieval/service";
import { runWithRuntimeSecrets } from "@/lib/runtime/secrets";
import { queryRateLimiter } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const querySchema = z.object({
  query: z.string().min(1).max(2000),
  conversationId: z.string().uuid().optional(),
  languageHint: z.enum(["EN", "DE", "FR", "IT", "ES"]).optional(),
  topK: z.number().int().positive().max(20).optional(),
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

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request, ["reader", "admin"]);
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

  const rate = queryRateLimiter.consume(
    `${authResult.user.id}:${ipAddress}`,
    env.AUTH_RATE_LIMIT_MAX_REQUESTS,
    env.AUTH_RATE_LIMIT_WINDOW_SECONDS * 1000,
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

  let userOpenAiApiKey: string | null = null;
  try {
    userOpenAiApiKey = await resolveUserOpenAiApiKey(authResult.user.id);
  } catch (error) {
    logAuditEvent({
      action: "query.execute",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: "query",
      ipAddress,
      metadata: {
        reason: "openai_byok_resolve_failed",
        message: error instanceof Error ? error.message : "unknown_error",
      },
    });
    return NextResponse.json({ error: "Failed to resolve OpenAI credentials" }, { status: 500 });
  }

  return runWithRuntimeSecrets(
    {
      openAiApiKey: userOpenAiApiKey ?? undefined,
    },
    async () => {
      const startedAt = Date.now();
      const topK = requestBody.topK ?? env.RAG_DEFAULT_TOP_K;

      try {
        const queryId = randomUUID();
        const conversationId = requestBody.conversationId ?? queryId;
        const retrievalResult = await retrieveRankedCandidates({
          query: requestBody.query,
          topK,
          languageHint: requestBody.languageHint,
        });

        const answerResult = await generateGroundedAnswer({
          query: requestBody.query,
          language: retrievalResult.trace.language,
          chunks: retrievalResult.chunks,
          minEvidenceChunks: env.RAG_MIN_EVIDENCE_CHUNKS,
          minRerankScore: env.RAG_MIN_RERANK_SCORE,
          maxOutputTokens: env.RAG_LLM_MAX_OUTPUT_TOKENS,
        });
        const latencyMs = Date.now() - startedAt;

        const retrievalMeta = {
          cacheHit: retrievalResult.trace.cacheHit,
          latencyMs,
          selectedChunkIds: retrievalResult.chunks.map((chunk) => chunk.chunkId),
          retrievalTrace: retrievalResult.trace,
          insufficientEvidence: answerResult.insufficientEvidence,
          conversationId,
          rateLimit: {
            remaining: rate.remaining,
            retryAfterSeconds: rate.retryAfterSeconds,
          },
        };

        const supabase = getSupabaseAdminClient();
        void supabase
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
          .then(({ error }) => {
            if (error) {
              logAuditEvent({
                action: "query.history.write",
                actorId: authResult.user.id,
                actorRole: authResult.user.role,
                outcome: "failure",
                resource: "query_history",
                ipAddress,
                metadata: { reason: "query_history_insert_failed", message: error.message },
              });
            }
          });

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
            selectedChunkCount: retrievalResult.chunks.length,
            cacheHit: retrievalResult.trace.cacheHit,
            retrievalVersion: retrievalResult.trace.retrievalVersion,
            insufficientEvidence: answerResult.insufficientEvidence,
            resolvedConversationId: conversationId,
            openAiKeySource: userOpenAiApiKey ? "byok_vault" : "server_env",
          },
        });

        const answerTokens = chunkAnswerText(answerResult.answer);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encodeSseEvent("meta", {
                queryId,
                retrievalMeta,
              }),
            );

            for (const token of answerTokens) {
              controller.enqueue(
                encodeSseEvent("token", {
                  queryId,
                  token,
                }),
              );
            }

            controller.enqueue(
              encodeSseEvent("final", {
                queryId,
                answer: answerResult.answer,
                citations: answerResult.citations,
                retrievalMeta,
              }),
            );
            controller.enqueue(encodeSseEvent("done", { queryId }));
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
